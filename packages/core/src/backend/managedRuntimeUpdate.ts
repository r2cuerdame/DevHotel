import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Where a runtime version change had got to.
 *
 * The stages exist so that a process that dies — or a Host that reboots —
 * mid-update leaves behind enough to decide what to do, rather than a runtime
 * whose version nobody can name. `staging` touches nothing on the Host, so it
 * is always safe to abandon; every later stage has to be either finished or
 * undone, and the stage says which.
 */
export type ManagedRuntimeUpdateStage =
  | 'staging'
  | 'applying'
  | 'verifying'
  | 'committed'
  | 'rolling-back'
  | 'rolled-back'
  | 'failed'

export interface ManagedRuntimeUpdateJournal {
  schemaVersion: 1
  owner: 'devhotel'
  /** The install that opened this update; a foreign one is never resumed. */
  installId: string
  runtimeId: string
  updateId: string
  fromVersion: string
  toVersion: string
  /** What the install had verified before the update, for an exact rollback. */
  fromArtifactDigests: Record<string, string>
  stage: ManagedRuntimeUpdateStage
  /** How many times this exact version change has been attempted. */
  attempts: number
  createdAt: string
  updatedAt: string
  failure?: string
}

export interface ManagedRuntimeUpdatePlan {
  runtimeId: string
  fromVersion: string
  toVersion: string
  fromArtifactDigests: Record<string, string>
}

export interface ManagedRuntimeUpdateLedgerOptions {
  /** The managed runtime root; the journal is never written anywhere else. */
  root: string
  installId: string
  now?: () => Date
  updateId?: () => string
}

export const MANAGED_RUNTIME_UPDATE_FILE = 'update.json'

/** Stages after which the Host holds no half-applied runtime. */
const TERMINAL_STAGES: readonly ManagedRuntimeUpdateStage[] = ['committed', 'rolled-back', 'failed']

const ALLOWED_TRANSITIONS: Readonly<Record<ManagedRuntimeUpdateStage, readonly ManagedRuntimeUpdateStage[]>> = {
  staging: ['applying', 'rolling-back', 'failed'],
  applying: ['verifying', 'rolling-back', 'failed'],
  verifying: ['committed', 'rolling-back', 'failed'],
  committed: [],
  'rolling-back': ['rolled-back', 'failed'],
  'rolled-back': [],
  failed: []
}

const VERSION = /^[0-9A-Za-z._-]{1,64}$/
const DIGEST = /^[a-f0-9]{64}$/
const ARTIFACT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function isTerminalManagedRuntimeUpdateStage(stage: ManagedRuntimeUpdateStage): boolean {
  return TERMINAL_STAGES.includes(stage)
}

function validateJournal(value: unknown, installId: string): ManagedRuntimeUpdateJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Managed runtime update journal is invalid')
  const journal = value as Partial<ManagedRuntimeUpdateJournal>
  if (
    journal.schemaVersion !== 1 ||
    journal.owner !== 'devhotel' ||
    typeof journal.installId !== 'string' ||
    journal.installId.length < 8 ||
    typeof journal.runtimeId !== 'string' ||
    journal.runtimeId.length < 1 ||
    typeof journal.updateId !== 'string' ||
    !/^[0-9A-Za-z-]{8,64}$/.test(journal.updateId) ||
    typeof journal.fromVersion !== 'string' ||
    !VERSION.test(journal.fromVersion) ||
    typeof journal.toVersion !== 'string' ||
    !VERSION.test(journal.toVersion) ||
    !journal.fromArtifactDigests ||
    typeof journal.fromArtifactDigests !== 'object' ||
    Array.isArray(journal.fromArtifactDigests) ||
    Object.entries(journal.fromArtifactDigests).some(
      ([id, digest]) => !ARTIFACT_ID.test(id) || typeof digest !== 'string' || !DIGEST.test(digest)
    ) ||
    !Object.keys(ALLOWED_TRANSITIONS).includes(journal.stage ?? '') ||
    !Number.isSafeInteger(journal.attempts) ||
    (journal.attempts ?? -1) < 1 ||
    typeof journal.createdAt !== 'string' ||
    typeof journal.updatedAt !== 'string' ||
    (journal.failure !== undefined && typeof journal.failure !== 'string')
  ) {
    throw new Error('Managed runtime update journal is invalid')
  }
  // An update opened by a different installation is never this install's to
  // resume: its "previous version" names a runtime this install never had.
  if (journal.installId !== installId) throw new Error('Managed runtime update journal belongs to another installation')
  return journal as ManagedRuntimeUpdateJournal
}

/**
 * The durable record of an in-flight runtime version change.
 *
 * It is written before anything on the Host is touched and updated after each
 * step, which is what makes an interrupted update recoverable rather than a
 * guess: a launch that finds a non-terminal journal knows both where the
 * previous attempt stopped and which version to put back. It is deliberately a
 * plain file in the runtime root — the same place the ownership manifest lives
 * — so a reboot, a crash and a killed installer all leave the same evidence.
 */
export class ManagedRuntimeUpdateLedger {
  private readonly root: string
  private readonly file: string
  private readonly installId: string
  private readonly now: () => Date
  private readonly updateId: () => string

  constructor(opts: ManagedRuntimeUpdateLedgerOptions) {
    this.root = path.resolve(opts.root)
    this.file = path.join(this.root, MANAGED_RUNTIME_UPDATE_FILE)
    this.installId = opts.installId
    this.now = opts.now ?? (() => new Date())
    this.updateId = opts.updateId ?? randomUUID
  }

  /** The journal on disk, or `null` when no update has ever been opened. */
  async read(): Promise<ManagedRuntimeUpdateJournal | null> {
    if (!existsSync(this.file)) return null
    const info = await lstat(this.file)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Managed runtime update journal is not a regular file')
    const canonical = await realpath(this.file)
    if (path.dirname(canonical).toLocaleLowerCase('en-US') !== (await realpath(this.root)).toLocaleLowerCase('en-US')) {
      throw new Error('Managed runtime update journal escaped its runtime root')
    }
    return validateJournal(JSON.parse(await readFile(canonical, 'utf8')), this.installId)
  }

  /**
   * Opens — or re-opens — the journal for one version change.
   *
   * Re-running the same change reuses the existing entry and counts the
   * attempt, so a Host that keeps dying mid-update accumulates evidence
   * instead of an endless series of fresh-looking first tries.
   */
  async begin(plan: ManagedRuntimeUpdatePlan): Promise<ManagedRuntimeUpdateJournal> {
    if (!VERSION.test(plan.fromVersion) || !VERSION.test(plan.toVersion)) {
      throw new Error('Managed runtime update versions are invalid')
    }
    if (plan.fromVersion === plan.toVersion) throw new Error('Managed runtime update has nothing to change')
    const existing = await this.read().catch(() => null)
    if (existing && !isTerminalManagedRuntimeUpdateStage(existing.stage)) {
      if (existing.toVersion !== plan.toVersion || existing.fromVersion !== plan.fromVersion) {
        throw new Error('Managed runtime already has a different update in flight')
      }
      return await this.write({ ...existing, attempts: existing.attempts + 1, stage: 'staging', failure: undefined })
    }
    const now = this.now().toISOString()
    return await this.write({
      schemaVersion: 1,
      owner: 'devhotel',
      installId: this.installId,
      runtimeId: plan.runtimeId,
      updateId: this.updateId(),
      fromVersion: plan.fromVersion,
      toVersion: plan.toVersion,
      fromArtifactDigests: { ...plan.fromArtifactDigests },
      stage: 'staging',
      attempts: existing && existing.toVersion === plan.toVersion ? existing.attempts + 1 : 1,
      createdAt: now,
      updatedAt: now
    })
  }

  async advance(updateId: string, stage: ManagedRuntimeUpdateStage): Promise<ManagedRuntimeUpdateJournal> {
    const journal = await this.require(updateId)
    if (!ALLOWED_TRANSITIONS[journal.stage].includes(stage)) {
      throw new Error(`Managed runtime update cannot move from ${journal.stage} to ${stage}`)
    }
    return await this.write({ ...journal, stage, failure: stage === 'committed' ? undefined : journal.failure })
  }

  async fail(updateId: string, stage: 'rolled-back' | 'failed', failure: string): Promise<ManagedRuntimeUpdateJournal> {
    const journal = await this.require(updateId)
    if (!ALLOWED_TRANSITIONS[journal.stage].includes(stage)) {
      throw new Error(`Managed runtime update cannot move from ${journal.stage} to ${stage}`)
    }
    return await this.write({ ...journal, stage, failure })
  }

  /**
   * Forgets a finished update.
   *
   * Only a committed one: a rolled-back or failed journal is the barrier that
   * stops the next launch from walking straight back into the update that just
   * broke, so it stays on disk until a different version supersedes it.
   */
  async clear(updateId: string): Promise<void> {
    const journal = await this.read().catch(() => null)
    if (!journal || journal.updateId !== updateId) return
    if (journal.stage !== 'committed') throw new Error('Managed runtime update is not committed')
    await rm(this.file, { force: true })
  }

  private async require(updateId: string): Promise<ManagedRuntimeUpdateJournal> {
    const journal = await this.read()
    if (!journal) throw new Error('Managed runtime update journal is missing')
    if (journal.updateId !== updateId) throw new Error('Managed runtime update identity changed')
    return journal
  }

  private async write(journal: ManagedRuntimeUpdateJournal): Promise<ManagedRuntimeUpdateJournal> {
    await mkdir(this.root, { recursive: true })
    const info = await lstat(this.root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Managed runtime root is not a real directory')
    const next = { ...journal, updatedAt: this.now().toISOString() }
    const temporary = path.join(this.root, `.update-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, this.file)
    } finally {
      await rm(temporary, { force: true })
    }
    return next
  }
}
