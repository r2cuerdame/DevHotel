import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import forge from 'node-forge'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { caTrustStatus, ensureCa, issueLeafCert } from '../gateway/ca'

let caDir: string

beforeAll(async () => {
  caDir = await mkdtemp(path.join(os.tmpdir(), 'devhotel-ca-'))
})

afterAll(async () => {
  await rm(caDir, { recursive: true, force: true })
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
