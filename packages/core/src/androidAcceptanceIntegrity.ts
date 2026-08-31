import { createHmac, timingSafeEqual, type BinaryLike } from 'node:crypto'
import type { AndroidAcceptanceMacIdentity } from '@devhotel/shared'
import type { Db } from './store/db'

export type AndroidAcceptanceMacDomain = AndroidAcceptanceMacIdentity['domain']

export interface AndroidAcceptanceMacAccumulator {
  update(value: BinaryLike): void
  digest(): AndroidAcceptanceMacIdentity
}

/** Installation-local keyed identities. The durable key never leaves Core. */
export class AndroidAcceptanceIntegrity {
  private readonly key: Buffer

  constructor(db: Db) {
    const secret = db.sqlite
      .prepare("SELECT value FROM android_acceptance_secrets WHERE name = 'acceptance-hmac-v1'")
      .get() as { value: Uint8Array } | undefined
    if (!secret || secret.value.byteLength !== 32) {
      throw new Error('Android acceptance integrity key is unavailable')
    }
    this.key = Buffer.from(secret.value)
  }

  create(domain: AndroidAcceptanceMacDomain): AndroidAcceptanceMacAccumulator {
    const hmac = createHmac('sha256', this.key)
    hmac.update(`devhotel:android-acceptance:${domain}:v1\0`, 'utf8')
    let finished = false
    return {
      update(value) {
        if (finished) throw new Error('Android acceptance MAC is already finalized')
        hmac.update(value)
      },
      digest() {
        if (finished) throw new Error('Android acceptance MAC is already finalized')
        finished = true
        return { algorithm: 'hmac-sha256', keyVersion: 1, domain, value: hmac.digest('hex') }
      }
    }
  }

  identify(domain: AndroidAcceptanceMacDomain, value: BinaryLike): AndroidAcceptanceMacIdentity {
    const accumulator = this.create(domain)
    accumulator.update(value)
    return accumulator.digest()
  }

  verify(identity: AndroidAcceptanceMacIdentity, value: BinaryLike): boolean {
    const expected = this.identify(identity.domain, value)
    const actualBytes = Buffer.from(identity.value, 'hex')
    const expectedBytes = Buffer.from(expected.value, 'hex')
    return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes)
  }
}
