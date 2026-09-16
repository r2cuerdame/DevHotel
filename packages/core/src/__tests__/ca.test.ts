import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import forge from 'node-forge'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { caTrustStatus, ensureCa, issueLeafCert, randomSerial } from '../gateway/ca'

let caDir: string

beforeAll(async () => {
  caDir = await mkdtemp(path.join(os.tmpdir(), 'devhotel-ca-'))
})

afterAll(async () => {
  await rm(caDir, { recursive: true, force: true })
})

describe('randomSerial', () => {
  // A serial that breaks these rules does not fail where it is generated. It
  // fails later, when OpenSSL loads the finished certificate, as
  // ERR_OSSL_ASN1_ILLEGAL_PADDING -- so the only cheap place to catch it is
  // here. The previous implementation forced just the top nibble to zero and
  // produced a rejected serial about 3% of the time, which read as a flaky
  // gateway suite rather than as a certificate bug.
  it('always encodes as a positive, minimally encoded DER INTEGER', () => {
    // 2,000 is not a round number picked for comfort. The defect this guards
    // against appeared in 3.06% of serials, so the chance of 2,000 clean
    // samples hiding it is about 1e-27. Twenty thousand bought nothing beyond
    // that and blocked the event loop long enough for vitest's worker RPC to
    // time out on a loaded CI runner, failing a run in which every test passed.
    const offenders: string[] = []
    for (let i = 0; i < 2_000; i += 1) {
      const serial = randomSerial()
      const lead = parseInt(serial.slice(0, 2), 16)
      const next = parseInt(serial.slice(2, 4), 16)
      // Negative: a leading byte >= 0x80 makes the INTEGER negative.
      // Illegal padding: a leading 0x00 is only legal before a byte >= 0x80.
      if (lead >= 0x80 || (lead === 0x00 && next < 0x80)) offenders.push(serial)
    }
    expect(offenders.slice(0, 5)).toEqual([])
  })

  it('stays a full-width, varied 16-byte serial', () => {
    const serials = new Set<string>()
    for (let i = 0; i < 500; i += 1) {
      const serial = randomSerial()
      expect(serial).toMatch(/^[0-9a-f]{32}$/)
      serials.add(serial)
    }
    expect(serials.size).toBe(500)
  })
})

describe('ensureCa', () => {
  it('creates a CA then loads the same one (same fingerprint)', async () => {
    const first = await ensureCa(caDir)
    expect(first.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    const cert = forge.pki.certificateFromPem(first.certPem)
    expect(cert.subject.getField('CN').value).toBe('DevHotel Local CA')
    const bc = cert.getExtension('basicConstraints') as { cA?: boolean } | undefined
    expect(bc?.cA).toBe(true)

    const second = await ensureCa(caDir)
    expect(second.fingerprint256).toBe(first.fingerprint256)
    expect(second.certPem).toBe(first.certPem)

    const files = await readdir(caDir)
    expect(files).toContain('rootCA.pem')
    expect(files).toContain('rootCA.key')
  }, 60000)
})

describe('issueLeafCert', () => {
  it('issues a CA-signed leaf with the domain in SAN, cached on disk', async () => {
    const domain = 'roomtest.localhost'
    const leaf = await issueLeafCert(caDir, domain)
    const again = await issueLeafCert(caDir, domain)
    expect(again.certPem).toBe(leaf.certPem)
    expect(again.keyPem).toBe(leaf.keyPem)

    const ca = await ensureCa(caDir)
    const caCert = forge.pki.certificateFromPem(ca.certPem)
    const leafCert = forge.pki.certificateFromPem(leaf.certPem)
    expect(caCert.verify(leafCert)).toBe(true)
    expect(leafCert.subject.getField('CN').value).toBe(domain)

    const san = leafCert.getExtension('subjectAltName') as
      | { altNames?: { type: number; value: string }[] }
      | undefined
    expect(san?.altNames?.some((n) => n.type === 2 && n.value === domain)).toBe(true)

    const eku = leafCert.getExtension('extKeyUsage') as { serverAuth?: boolean } | undefined
    expect(eku?.serverAuth).toBe(true)
  }, 60000)
})

describe('caTrustStatus', () => {
  it('reports missing when no CA exists', async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), 'devhotel-ca-empty-'))
    try {
      expect(await caTrustStatus(empty)).toBe('missing')
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  it('reports untrusted for a freshly generated CA', async () => {
    await ensureCa(caDir)
    expect(await caTrustStatus(caDir)).toBe('untrusted')
  }, 60000)
})
