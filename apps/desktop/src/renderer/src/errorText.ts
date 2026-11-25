import { RENDERER_ERROR_PREFIX, type RendererErrorPayload } from '@devhotel/shared'
import type { TFunc } from './i18n'

const ELECTRON_INVOKE_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/

function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err === null || err === undefined) return ''
  return String(err)
}

function parsePayload(text: string): RendererErrorPayload | null {
  const at = text.indexOf(RENDERER_ERROR_PREFIX)
  if (at < 0) return null
  try {
    const value: unknown = JSON.parse(text.slice(at + RENDERER_ERROR_PREFIX.length))
    if (!value || typeof value !== 'object') return null
    const { code, message, recoveryHint } = value as Record<string, unknown>
    if (typeof code !== 'string') return null
    return {
      code,
      ...(typeof message === 'string' ? { message } : {}),
      ...(typeof recoveryHint === 'string' ? { recoveryHint } : {})
    }
  } catch {
    return null
  }
}

export function describeError(err: unknown, t: TFunc): string {
  const text = rawMessage(err).replace(ELECTRON_INVOKE_PREFIX, '').trim()
  const payload = parsePayload(text)
  if (!payload) return text || t('error.unknown')
  if (payload.code === 'INVALID_INPUT') return t('error.invalidInput')
  const message = payload.message?.trim() || t('error.unknown')
  const hint = payload.recoveryHint?.trim()
  return hint ? `${message}\n${t('error.recoveryHint', { hint })}` : message
}
