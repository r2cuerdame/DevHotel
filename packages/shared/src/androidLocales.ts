import { z } from 'zod'
import {
  zAndroidApplicationId,
  type AndroidAutomationTarget
} from './androidAutomation'
import { zArtifactAssociation, type RoomArtifact } from './artifacts'

export const ANDROID_APP_LOCALE_MIN_API = 33
export const ANDROID_LOCALE_MATRIX_MAX_ENTRIES = 16

/**
 * Canonicalize one bounded BCP 47 tag before it crosses an Android command
 * boundary. `und` is not a useful UI selection and is deliberately rejected.
 */
export function canonicalAndroidLocaleTag(value: string): string | null {
  if (
    value.length < 2 ||
    value.length > 63 ||
    !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value)
  ) return null

  try {
    const canonical = Intl.getCanonicalLocales(value)
    const locale = canonical.length === 1 ? canonical[0] : undefined
    return locale && locale.toLowerCase() !== 'und' ? locale : null
  } catch {
    return null
  }
}

export function canonicalAndroidLocaleTags(
  values: readonly string[],
  options: { allowEmpty?: boolean } = {}
): string[] | null {
  if (
    values.length > ANDROID_LOCALE_MATRIX_MAX_ENTRIES ||
    (!options.allowEmpty && values.length === 0)
  ) return null

  const canonical: string[] = []
  for (const value of values) {
    const locale = canonicalAndroidLocaleTag(value)
    if (!locale || canonical.includes(locale)) return null
    canonical.push(locale)
  }
  return canonical
}

export const zAndroidLocaleTag = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/, 'BCP 47 locale tag')
  .refine((value) => canonicalAndroidLocaleTag(value) !== null, 'supported BCP 47 locale tag')
  .transform((value) => canonicalAndroidLocaleTag(value)!)

export const zAndroidLocaleMatrixTags = z
  .array(zAndroidLocaleTag)
  .min(1)
  .max(ANDROID_LOCALE_MATRIX_MAX_ENTRIES)
  .refine((locales) => new Set(locales).size === locales.length, 'locale tags must be unique')

export const zAndroidLocaleFilenamePrefix = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'portable screenshot filename prefix')

export const zAndroidLocaleReadinessTimeoutMs = z.number().int().min(1_000).max(120_000)

export const zAndroidLocaleScreenshotMatrixBody = z
  .object({
    applicationId: zAndroidApplicationId,
    locales: zAndroidLocaleMatrixTags,
    filenamePrefix: zAndroidLocaleFilenamePrefix,
    readinessTimeoutMs: zAndroidLocaleReadinessTimeoutMs.optional(),
    // Locale matrices are recoverable only against the Room's managed
    // emulator. Auto-selection and physical leases deliberately remain
    // available to ordinary Android automation, but not to this persistent
    // multi-step mutation.
    target: z.object({ kind: z.literal('emulator') }).strict().optional(),
    association: zArtifactAssociation.optional()
  })
  .strict()

export type AndroidLocaleScreenshotMatrixInput = z.infer<typeof zAndroidLocaleScreenshotMatrixBody>

export interface AndroidLocaleReadiness {
  adb: 'device'
  localeService: 'ready'
  application: 'foreground'
  process: 'running'
  attempts: number
  consecutiveReadyChecks: 2
  elapsedMs: number
  pids: number[]
}

export interface AndroidLocaleProcessTransition {
  beforePids: number[]
  afterPids: number[]
  restarted: boolean
}

export interface AndroidLocaleScreenshotMatrixEntry {
  locale: string
  readiness: AndroidLocaleReadiness
  process: AndroidLocaleProcessTransition
  /** Durable receipt only. Pixel content is fetched through the artifact API. */
  artifact: RoomArtifact
}

export interface AndroidLocaleScreenshotMatrixResult {
  target: AndroidAutomationTarget
  applicationId: string
  apiLevel: number
  scope: 'app'
  entries: AndroidLocaleScreenshotMatrixEntry[]
  restoration: {
    localeTags: string[]
    readiness: AndroidLocaleReadiness
  }
}

export function androidLocaleScreenshotFilename(prefix: string, locale: string): string {
  const safePrefix = zAndroidLocaleFilenamePrefix.parse(prefix)
  const safeLocale = zAndroidLocaleTag.parse(locale)
  return `${safePrefix}-${safeLocale.toLowerCase()}.png`
}
