import { describe, expect, it } from 'vitest'
import { PreviewSyncGuard } from './previewSync'

describe('responsive preview navigation guard', () => {
  it('consumes rapid left-to-right loads without reflecting them back to left', () => {
    const guard = new PreviewSyncGuard()
    guard.mark('https://room.localhost/a')
    guard.mark('https://room.localhost/b')

    expect(guard.consume('https://room.localhost/a')).toBe(true)
    expect(guard.consume('https://room.localhost/b')).toBe(true)
    expect(guard.consume('https://room.localhost/user-route')).toBe(false)
  })

  it('releases failed and stale mirror loads', () => {
    const guard = new PreviewSyncGuard()
    guard.mark('https://room.localhost/failed')
    guard.fail('https://room.localhost/failed')
    expect(guard.consume('https://room.localhost/failed')).toBe(false)

    for (let index = 0; index < 34; index += 1) guard.mark(`https://room.localhost/${index}`)
    expect(guard.consume('https://room.localhost/0')).toBe(false)
    expect(guard.consume('https://room.localhost/33')).toBe(true)
  })
})
