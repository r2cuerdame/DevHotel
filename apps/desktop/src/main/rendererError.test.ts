import { describe, expect, it } from 'vitest'
import { DevHotelError } from '@devhotel/core'
import { RENDERER_ERROR_PREFIX, zRoomId } from '@devhotel/shared'
import { toRendererError } from './rendererError'

function payloadOf(err: unknown): unknown {
  expect(err).toBeInstanceOf(Error)
  const message = (err as Error).message
  expect(message.startsWith(RENDERER_ERROR_PREFIX)).toBe(true)
  return JSON.parse(message.slice(RENDERER_ERROR_PREFIX.length))
}

describe('toRendererError', () => {
  it('carries the DevHotelError code, message and recovery hint', () => {
    const err = new DevHotelError('ROOM_NOT_RUNNING', 'Room is asleep', {
      recoveryHint: 'Wake the Room first',
      evidence: { secret: 'never-sent' }
    })
    expect(payloadOf(toRendererError(err))).toEqual({
      code: 'ROOM_NOT_RUNNING',
      message: 'Room is asleep',
      recoveryHint: 'Wake the Room first'
    })
  })

  it('omits an absent recovery hint', () => {
    expect(payloadOf(toRendererError(new DevHotelError('BUSY', 'Room is busy')))).toEqual({
      code: 'BUSY',
      message: 'Room is busy'
    })
  })

  it('reduces a ZodError to INVALID_INPUT without echoing the entered value', () => {
    const result = zRoomId.safeParse('private-value-123')
    expect(result.success).toBe(false)
    const converted = toRendererError(result.error)
    expect(payloadOf(converted)).toEqual({ code: 'INVALID_INPUT' })
    expect((converted as Error).message).not.toContain('private-value-123')
    expect((converted as Error).message).not.toContain('valid Room ID')
  })

  it('passes other errors through unchanged', () => {
    const plain = new Error('disk full')
    expect(toRendererError(plain)).toBe(plain)
    expect(toRendererError('text')).toBe('text')
  })
})
