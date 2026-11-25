import { isDevHotelError } from '@devhotel/core'
import { RENDERER_ERROR_PREFIX, type RendererErrorPayload } from '@devhotel/shared'

function isZodError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ZodError' && Array.isArray((err as { issues?: unknown }).issues)
}

function encode(payload: RendererErrorPayload): Error {
  return new Error(RENDERER_ERROR_PREFIX + JSON.stringify(payload))
}

export function toRendererError(err: unknown): unknown {
  if (isDevHotelError(err)) {
    return encode({
      code: err.code,
      message: err.message,
      ...(err.recoveryHint ? { recoveryHint: err.recoveryHint } : {})
    })
  }
  if (isZodError(err)) return encode({ code: 'INVALID_INPUT' })
  return err
}
