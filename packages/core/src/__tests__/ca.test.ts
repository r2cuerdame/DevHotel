import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
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

/** Throws when OpenSSL rejects the pair, e.g. ERR_OSSL_X509_KEY_VALUES_MISMATCH or a PEM parse error. */
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
  it('converges on one CA and one leaf pair when callers race on an empty directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'devhotel-ca-race-'))
    try {
      const domain = 'race.localhost'
      const results = await Promise.all([
        ensureCa(dir),
        issueLeafCert(dir, domain),
        ensureCa(dir),
        issueLeafCert(dir, domain),
        issueLeafCert(dir, domain),
        ensureCa(dir)
      ])
      const cas = [results[0], results[2], results[5]] as Awaited<ReturnType<typeof ensureCa>>[]
      const leaves = [results[1], results[3], results[4]] as Awaited<ReturnType<typeof issueLeafCert>>[]
      expect(new Set(cas.map((ca) => ca.certPem)).size).toBe(1)
      expect(new Set(leaves.map((leaf) => leaf.certPem)).size).toBe(1)
      expect(new Set(leaves.map((leaf) => leaf.keyPem)).size).toBe(1)

      // what is on disk is exactly the pair every caller got back
      expect(await readFile(path.join(dir, 'rootCA.pem'), 'utf8')).toBe(cas[0]!.certPem)
      expect(await readFile(path.join(dir, 'rootCA.key'), 'utf8')).toBe(cas[0]!.keyPem)
      expect(await readFile(path.join(dir, 'certs', `${domain}.pem`), 'utf8')).toBe(leaves[0]!.certPem)
      expect(await readFile(path.join(dir, 'certs', `${domain}.key`), 'utf8')).toBe(leaves[0]!.keyPem)
      expect(signedBy(leaves[0]!.certPem, cas[0]!.certPem)).toBe(true)
      assertLoadable(leaves[0]!, cas[0]!.certPem)

      // no temp file is left behind by the atomic replace
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

  it('replaces an empty or unparsable root CA instead of throwing', async () => {
    const original = await ensureCa(dir)

    await writeFile(path.join(dir, 'rootCA.key'), '')
    const fromEmptyKey = await ensureCa(dir)
    expect(fromEmptyKey.certPem).not.toBe(original.certPem)
    assertLoadable({ certPem: fromEmptyKey.certPem, keyPem: fromEmptyKey.keyPem }, '')

    await writeFile(path.join(dir, 'rootCA.pem'), '-----BEGIN CERTIFICATE-----\nnot base64\n')
    const fromGarbage = await ensureCa(dir)
    expect(fromGarbage.certPem).not.toBe(fromEmptyKey.certPem)
    assertLoadable({ certPem: fromGarbage.certPem, keyPem: fromGarbage.keyPem }, '')
    expect(await readFile(path.join(dir, 'rootCA.pem'), 'utf8')).toBe(fromGarbage.certPem)
  }, 60000)

  it('replaces a root CA whose key belongs to a different certificate', async () => {
    const before = await ensureCa(dir)
    const leaf = await issueLeafCert(dir, 'donor.localhost')
    await writeFile(path.join(dir, 'rootCA.key'), leaf.keyPem)
    const repaired = await ensureCa(dir)
    expect(repaired.certPem).not.toBe(before.certPem)
    assertLoadable({ certPem: repaired.certPem, keyPem: repaired.keyPem }, '')
  }, 60000)

  it('reissues a leaf whose key file is empty or does not match its certificate', async () => {
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
    const caKey = forge.pki.privateKeyFromPem(ca.keyPem)
    const current = await issueLeafCert(dir, domain)

    // same key, same CA, but the validity window is over
    const stale = forge.pki.certificateFromPem(current.certPem)
    stale.validity.notBefore = new Date(Date.now() - 900 * 24 * 60 * 60 * 1000)
    stale.validity.notAfter = new Date(Date.now() - 24 * 60 * 60 * 1000)
    stale.sign(caKey, forge.md.sha256.create())
    expect(forge.pki.certificateFromPem(ca.certPem).verify(stale)).toBe(true)
    await writeFile(path.join(dir, 'certs', `${domain}.pem`), forge.pki.certificateToPem(stale))
    const renewed = await issueLeafCert(dir, domain)
    const renewedCert = forge.pki.certificateFromPem(renewed.certPem)
    expect(renewedCert.validity.notAfter.getTime()).toBeGreaterThan(Date.now())
    assertLoadable(renewed, ca.certPem)

    // a valid pair that names a different host is not served for this one
    const wrongHost = await issueLeafCert(dir, 'elsewhere.localhost')
    await writeFile(path.join(dir, 'certs', `${domain}.pem`), wrongHost.certPem)
    await writeFile(path.join(dir, 'certs', `${domain}.key`), wrongHost.keyPem)
    const reissued = await issueLeafCert(dir, domain)
    expect(reissued.certPem).not.toBe(wrongHost.certPem)
    const san = forge.pki.certificateFromPem(reissued.certPem).getExtension('subjectAltName') as
      | { altNames?: { type: number; value: string }[] }
      | undefined
    expect(san?.altNames?.some((n) => n.type === 2 && n.value === domain)).toBe(true)
  }, 60000)

  it('reissues leaves signed by a previous root CA after the CA is regenerated', async () => {
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
    expect(signedBy(newLeaf.certPem, newCa.certPem)).toBe(true)
    assertLoadable(newLeaf, newCa.certPem)
    // and a valid current leaf is still kept as-is
    expect((await issueLeafCert(dir, domain)).certPem).toBe(newLeaf.certPem)
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
