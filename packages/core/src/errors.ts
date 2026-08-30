export class DevHotelError extends Error {
  readonly code: string
  readonly recoveryHint: string | null
  readonly httpStatus: number
  readonly evidence: unknown | null

  constructor(
    code: string,
    message: string,
    options?: { recoveryHint?: string; httpStatus?: number; cause?: unknown; evidence?: unknown }
  ) {
    super(message, { cause: options?.cause })
    this.name = 'DevHotelError'
    this.code = code
    this.recoveryHint = options?.recoveryHint ?? null
    this.httpStatus = options?.httpStatus ?? 409
    this.evidence = options?.evidence ?? null
  }
}

export function isDevHotelError(error: unknown): error is DevHotelError {
  return error instanceof DevHotelError
}
