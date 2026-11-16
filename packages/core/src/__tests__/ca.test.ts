import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import forge from 'node-forge'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { caTrustStatus, ensureCa, issueLeafCert, randomSerial, subscribeCa } from '../gateway/ca'

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

function assertLoadable(leaf: { certPem: string; keyPem: string }, caCertPem: string): void {
  tls.createSecureContext({ key: leaf.keyPem, cert: leaf.certPem + caCertPem })
}

function signedBy(certPem: string, caCertPem: string): boolean {
  try {
    return forge.pki.certificateFromPem(caCertPem).verify(forge.pki.certificateFromPem(certPem))
  } catch {
    return false
  }
}

describe('concurrent issuance', () => {
  it('pairs one CA and one leaf when callers race on an empty directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'devhotel-ca-race-'))
    try {
      const domain = 'race.localhost'
      const [ca1, leaf1, ca2, leaf2, leaf3, ca3] = await Promise.all([
        ensureCa(dir),
        issueLeafCert(dir, domain),
        ensureCa(dir),
        issueLeafCert(dir, domain),
        issueLeafCert(dir, domain),
        ensureCa(dir)
      ])
      expect(new Set([ca1.certPem, ca2.certPem, ca3.certPem]).size).toBe(1)
      expect(new Set([leaf1.certPem, leaf2.certPem, leaf3.certPem]).size).toBe(1)
      expect(new Set([leaf1.keyPem, leaf2.keyPem, leaf3.keyPem]).size).toBe(1)

      expect(await readFile(path.join(dir, 'rootCA.pem'), 'utf8')).toBe(ca1.certPem)
      expect(await readFile(path.join(dir, 'rootCA.key'), 'utf8')).toBe(ca1.keyPem)
      expect(await readFile(path.join(dir, 'certs', `${domain}.pem`), 'utf8')).toBe(leaf1.certPem)
      expect(await readFile(path.join(dir, 'certs', `${domain}.key`), 'utf8')).toBe(leaf1.keyPem)
      expect(signedBy(leaf1.certPem, ca1.certPem)).toBe(true)
      assertLoadable(leaf1, ca1.certPem)

      expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
      expect((await readdir(path.join(dir, 'certs'))).filter((f) => f.endsWith('.tmp'))).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60000)
})

describe('repairing damaged certificate files', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'devhotel-ca-repair-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('replaces an empty, unparsable or mismatched root CA instead of throwing', async () => {
    const original = await ensureCa(dir)

    await writeFile(path.join(dir, 'rootCA.key'), '')
    const fromEmpty = await ensureCa(dir)
    expect(fromEmpty.certPem).not.toBe(original.certPem)
    assertLoadable(fromEmpty, '')

    await writeFile(path.join(dir, 'rootCA.pem'), '-----BEGIN CERTIFICATE-----\nnot base64\n')
    const fromGarbage = await ensureCa(dir)
    expect(fromGarbage.certPem).not.toBe(fromEmpty.certPem)
    expect(await readFile(path.join(dir, 'rootCA.pem'), 'utf8')).toBe(fromGarbage.certPem)

    const donor = await issueLeafCert(dir, 'donor.localhost')
    await writeFile(path.join(dir, 'rootCA.key'), donor.keyPem)
    const fromMismatch = await ensureCa(dir)
    expect(fromMismatch.certPem).not.toBe(fromGarbage.certPem)
    assertLoadable(fromMismatch, '')
  }, 60000)

  it('replaces an expired root CA', async () => {
    const current = await ensureCa(dir)
    const cert = forge.pki.certificateFromPem(current.certPem)
    const key = forge.pki.privateKeyFromPem(current.keyPem)
    const expired = forge.pki.createCertificate()
    expired.publicKey = cert.publicKey
    expired.serialNumber = randomSerial()
    expired.validity.notBefore = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    expired.validity.notAfter = new Date(Date.now() - 24 * 60 * 60 * 1000)
    expired.setSubject(cert.subject.attributes)
    expired.setIssuer(cert.subject.attributes)
    expired.setExtensions([{ name: 'basicConstraints', cA: true, critical: true }])
    expired.sign(key, forge.md.sha256.create())
    await writeFile(path.join(dir, 'rootCA.pem'), forge.pki.certificateToPem(expired))

    const renewed = await ensureCa(dir)
    expect(renewed.keyPem).not.toBe(current.keyPem)
    expect(forge.pki.certificateFromPem(renewed.certPem).validity.notAfter.getTime()).toBeGreaterThan(Date.now())
  }, 60000)

  it('reissues a leaf whose key is empty or belongs to another certificate', async () => {
    const domain = 'damaged.localhost'
    const ca = await ensureCa(dir)
    const first = await issueLeafCert(dir, domain)

    await writeFile(path.join(dir, 'certs', `${domain}.key`), '')
    const fromEmpty = await issueLeafCert(dir, domain)
    expect(fromEmpty.certPem).not.toBe(first.certPem)
    assertLoadable(fromEmpty, ca.certPem)

    const other = await issueLeafCert(dir, 'other.localhost')
    await writeFile(path.join(dir, 'certs', `${domain}.key`), other.keyPem)
    const fromMismatch = await issueLeafCert(dir, domain)
    expect(fromMismatch.certPem).not.toBe(fromEmpty.certPem)
    assertLoadable(fromMismatch, ca.certPem)
    expect(await readFile(path.join(dir, 'certs', `${domain}.key`), 'utf8')).toBe(fromMismatch.keyPem)
  }, 60000)

  it('reissues an expired leaf and a leaf issued for another domain', async () => {
    const domain = 'expired.localhost'
    const ca = await ensureCa(dir)
    const current = await issueLeafCert(dir, domain)

    const stale = forge.pki.certificateFromPem(current.certPem)
    stale.validity.notBefore = new Date(Date.now() - 900 * 24 * 60 * 60 * 1000)
    stale.validity.notAfter = new Date(Date.now() - 24 * 60 * 60 * 1000)
    stale.sign(forge.pki.privateKeyFromPem(ca.keyPem), forge.md.sha256.create())
    await writeFile(path.join(dir, 'certs', `${domain}.pem`), forge.pki.certificateToPem(stale))
    const renewed = await issueLeafCert(dir, domain)
    expect(forge.pki.certificateFromPem(renewed.certPem).validity.notAfter.getTime()).toBeGreaterThan(Date.now())
    assertLoadable(renewed, ca.certPem)

    const wrongHost = await issueLeafCert(dir, 'elsewhere.localhost')
    await writeFile(path.join(dir, 'certs', `${domain}.pem`), wrongHost.certPem)
    await writeFile(path.join(dir, 'certs', `${domain}.key`), wrongHost.keyPem)
    const reissued = await issueLeafCert(dir, domain)
    const san = forge.pki.certificateFromPem(reissued.certPem).getExtension('subjectAltName') as
      | { altNames?: { type: number; value: string }[] }
      | undefined
    expect(san?.altNames?.some((n) => n.type === 2 && n.value === domain)).toBe(true)
  }, 60000)

  it('reissues a leaf signed by a previous root after the root is regenerated', async () => {
    const domain = 'rotated.localhost'
    const oldCa = await ensureCa(dir)
    const oldLeaf = await issueLeafCert(dir, domain)
    expect(signedBy(oldLeaf.certPem, oldCa.certPem)).toBe(true)

    await rm(path.join(dir, 'rootCA.pem'))
    await rm(path.join(dir, 'rootCA.key'))
    const newCa = await ensureCa(dir)
    expect(newCa.certPem).not.toBe(oldCa.certPem)

    const newLeaf = await issueLeafCert(dir, domain)
    expect(newLeaf.certPem).not.toBe(oldLeaf.certPem)
    expect(newLeaf.caCertPem).toBe(newCa.certPem)
    expect(signedBy(newLeaf.certPem, newCa.certPem)).toBe(true)
    assertLoadable(newLeaf, newCa.certPem)
    expect((await issueLeafCert(dir, domain)).certPem).toBe(newLeaf.certPem)
  }, 60000)
})

describe('subscribeCa', () => {
  it('tells subscribers about the CA ensureCa resolved, including a regenerated one', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'devhotel-ca-sub-'))
    try {
      const seen: string[] = []
      const unsubscribe = subscribeCa(dir, (ca) => {
        seen.push(ca.certPem)
      })
      const initial = await ensureCa(dir)
      expect(seen).toEqual([initial.certPem])

      await writeFile(path.join(dir, 'rootCA.key'), 'corrupted')
      const leaf = await issueLeafCert(dir, 'sub.localhost')
      expect(leaf.caCertPem).not.toBe(initial.certPem)
      expect(seen.at(-1)).toBe(leaf.caCertPem)

      unsubscribe()
      await writeFile(path.join(dir, 'rootCA.key'), 'corrupted again')
      const after = await ensureCa(dir)
      expect(seen).not.toContain(after.certPem)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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
