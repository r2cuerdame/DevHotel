export class DevHotelError extends Error {
  readonly code: string
  readonly recoveryHint: string | null
  readonly httpStatus: number

  constructor(code: string, message: string, options?: { recoveryHint?: string; httpStatus?: number; cause?: unknown }) {
    super(message, { cause: options?.cause })
    this.name = 'DevHotelError'
    this.code = code
    this.recoveryHint = options?.recoveryHint ?? null
    this.httpStatus = options?.httpStatus ?? 409
  }
}

export function isDevHotelError(error: unknown): error is DevHotelError {
  return error instanceof DevHotelError
}
