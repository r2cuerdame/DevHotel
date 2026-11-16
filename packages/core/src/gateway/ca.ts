import { execFile } from 'node:child_process'
import { generateKeyPair } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import forge from 'node-forge'

const execFileAsync = promisify(execFile)
const generateKeyPairAsync = promisify(generateKeyPair)

const CA_NAME = 'DevHotel Local CA'
const DAY_MS = 24 * 60 * 60 * 1000
const LEAF_RENEW_MARGIN_MS = 30 * DAY_MS
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY'])

export interface CaMaterial {
  certPem: string
  keyPem: string
  fingerprint256: string
}

export interface LeafCertMaterial {
  certPem: string
  keyPem: string
  caCertPem: string
}

export type CaListener = (ca: CaMaterial) => void | Promise<void>

interface LoadedCa {
  certPem: string
  keyPem: string
  cert: forge.pki.Certificate
  key: forge.pki.rsa.PrivateKey
}

function rootCertPath(caDir: string): string {
  return path.join(caDir, 'rootCA.pem')
}

function rootKeyPath(caDir: string): string {
  return path.join(caDir, 'rootCA.key')
}

/**
 * A DER INTEGER serial must be positive (leading byte < 0x80) and minimally
 * encoded (no leading 0x00 before a byte < 0x80); OpenSSL rejects violations
 * only when the finished certificate is loaded (ERR_OSSL_ASN1_ILLEGAL_PADDING).
 * A leading byte in 0x01..0x7f satisfies both.
 */
export function randomSerial(): string {
  const lead = (forge.random.getBytesSync(1).charCodeAt(0) % 0x7f) + 1
  const rest = forge.util.bytesToHex(forge.random.getBytesSync(15))
  return lead.toString(16).padStart(2, '0') + rest
}

function fingerprintOf(cert: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
  const md = forge.md.sha256.create()
  md.update(der)
  const hex = md.digest().toHex().toUpperCase()
  return hex.match(/.{2}/g)!.join(':')
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file, 'utf8')
    return true
  } catch {
    return false
  }
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

function dirKey(caDir: string): string {
  const resolved = path.resolve(caDir)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const inFlight = new Map<string, Promise<unknown>>()

function singleFlight<T>(key: string, work: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(key) as Promise<T> | undefined
  if (pending) return pending
  const run = work().finally(() => inFlight.delete(key))
  inFlight.set(key, run)
  return run
}

const caListeners = new Map<string, Set<CaListener>>()

export function subscribeCa(caDir: string, listener: CaListener): () => void {
  const key = dirKey(caDir)
  let listeners = caListeners.get(key)
  if (!listeners) {
    listeners = new Set()
    caListeners.set(key, listeners)
  }
  listeners.add(listener)
  return () => {
    const current = caListeners.get(key)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) caListeners.delete(key)
  }
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${forge.util.bytesToHex(forge.random.getBytesSync(6))}.tmp`
  try {
    await writeFile(tmp, content, 'utf8')
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tmp, file)
        return
      } catch (err) {
        // Windows: a reader or antivirus scan briefly holding the target fails the rename
        const code = (err as NodeJS.ErrnoException).code
        if (attempt >= 5 || !code || !RETRYABLE_RENAME.has(code)) throw err
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
      }
    }
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

async function generateRsaKeyPair(): Promise<forge.pki.rsa.KeyPair> {
  const { privateKey } = await generateKeyPairAsync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })
  const priv = forge.pki.privateKeyFromPem(privateKey)
  return { privateKey: priv, publicKey: forge.pki.setRsaPublicKey(priv.n, priv.e) }
}

function keyMatchesCert(key: forge.pki.rsa.PrivateKey, cert: forge.pki.Certificate): boolean {
  const pub = cert.publicKey as forge.pki.rsa.PublicKey
  return Boolean(pub?.n && pub?.e && pub.n.equals(key.n) && pub.e.equals(key.e))
}

function validAt(cert: forge.pki.Certificate, now: number, marginMs: number): boolean {
  return cert.validity.notBefore.getTime() <= now && cert.validity.notAfter.getTime() - marginMs > now
}

async function loadCa(caDir: string): Promise<LoadedCa | null> {
  const [certPem, keyPem] = await Promise.all([
    readOptional(rootCertPath(caDir)),
    readOptional(rootKeyPath(caDir))
  ])
  if (!certPem || !keyPem) return null
  try {
    const cert = forge.pki.certificateFromPem(certPem)
    const key = forge.pki.privateKeyFromPem(keyPem)
    const bc = cert.getExtension('basicConstraints') as { cA?: boolean } | undefined
    if (!bc?.cA || !keyMatchesCert(key, cert) || !validAt(cert, Date.now(), 0) || !cert.verify(cert)) {
      return null
    }
    return { certPem, keyPem, cert, key }
  } catch {
    return null
  }
}

async function loadOrCreateCa(caDir: string): Promise<LoadedCa> {
  await mkdir(caDir, { recursive: true })
  const existing = await loadCa(caDir)
  if (existing) return existing

  const keys = await generateRsaKeyPair()
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = randomSerial()
  cert.validity.notBefore = new Date(Date.now() - DAY_MS)
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * DAY_MS)
  const attrs = [{ name: 'commonName', value: CA_NAME }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' }
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())

  const certPem = forge.pki.certificateToPem(cert)
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey)
  await writeAtomic(rootKeyPath(caDir), keyPem)
  await writeAtomic(rootCertPath(caDir), certPem)
  return { certPem, keyPem, cert, key: keys.privateKey }
}

export async function ensureCa(caDir: string): Promise<CaMaterial> {
  const material = await singleFlight(`${dirKey(caDir)}\0ca`, async () => {
    const ca = await loadOrCreateCa(caDir)
    return { certPem: ca.certPem, keyPem: ca.keyPem, fingerprint256: fingerprintOf(ca.cert) }
  })
  const listeners = caListeners.get(dirKey(caDir))
  if (listeners) {
    for (const listener of [...listeners]) await listener(material)
  }
  return material
}

function leafUsable(certPem: string, keyPem: string, domain: string, caCert: forge.pki.Certificate): boolean {
  try {
    const cert = forge.pki.certificateFromPem(certPem)
    const key = forge.pki.privateKeyFromPem(keyPem)
    if (!keyMatchesCert(key, cert) || !validAt(cert, Date.now(), LEAF_RENEW_MARGIN_MS)) return false
    const san = cert.getExtension('subjectAltName') as
      | { altNames?: { type: number; value: string }[] }
      | undefined
    if (!san?.altNames?.some((n) => n.type === 2 && n.value === domain)) return false
    return caCert.verify(cert)
  } catch {
    return false
  }
}

async function loadOrIssueLeaf(caDir: string, domain: string, ca: CaMaterial): Promise<LeafCertMaterial> {
  const caCert = forge.pki.certificateFromPem(ca.certPem)
  const certsDir = path.join(caDir, 'certs')
  await mkdir(certsDir, { recursive: true })
  const certFile = path.join(certsDir, `${domain}.pem`)
  const keyFile = path.join(certsDir, `${domain}.key`)

  const [storedCert, storedKey] = await Promise.all([readOptional(certFile), readOptional(keyFile)])
  if (storedCert && storedKey && leafUsable(storedCert, storedKey, domain, caCert)) {
    return { certPem: storedCert, keyPem: storedKey, caCertPem: ca.certPem }
  }

  const caKey = forge.pki.privateKeyFromPem(ca.keyPem)
  const keys = await generateRsaKeyPair()
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = randomSerial()
  cert.validity.notBefore = new Date(Date.now() - DAY_MS)
  cert.validity.notAfter = new Date(Date.now() + 825 * DAY_MS)
  cert.setSubject([{ name: 'commonName', value: domain }])
  cert.setIssuer(caCert.subject.attributes)
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: domain }] }
  ])
  cert.sign(caKey, forge.md.sha256.create())

  const certPem = forge.pki.certificateToPem(cert)
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey)
  await writeAtomic(keyFile, keyPem)
  await writeAtomic(certFile, certPem)
  return { certPem, keyPem, caCertPem: ca.certPem }
}

export async function issueLeafCert(caDir: string, domain: string, ca?: CaMaterial): Promise<LeafCertMaterial> {
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.includes('..')) {
    throw new Error(`refusing to issue a certificate for suspicious domain: ${JSON.stringify(domain)}`)
  }
  const signer = ca ?? (await ensureCa(caDir))
  return singleFlight(`${dirKey(caDir)}\0leaf\0${domain}\0${signer.fingerprint256}`, () =>
    loadOrIssueLeaf(caDir, domain, signer)
  )
}

async function caSerialHex(caDir: string): Promise<string> {
  const certPem = await readFile(rootCertPath(caDir), 'utf8')
  const cert = forge.pki.certificateFromPem(certPem)
  return cert.serialNumber.toLowerCase()
}

export async function caTrustStatus(caDir: string): Promise<'trusted' | 'untrusted' | 'missing'> {
  if (!(await exists(rootCertPath(caDir)))) return 'missing'
  if (process.platform !== 'win32') return 'untrusted'
  let serial: string
  try {
    serial = await caSerialHex(caDir)
  } catch {
    return 'missing'
  }
  try {
    const { stdout } = await execFileAsync('certutil', ['-user', '-store', 'Root'])
    const out = stdout.toLowerCase()
    const stripped = serial.replace(/^0+/, '')
    return out.includes(serial) || (stripped.length > 0 && out.includes(stripped))
      ? 'trusted'
      : 'untrusted'
  } catch {
    return 'untrusted'
  }
}

export async function trustCaInWindows(caDir: string): Promise<void> {
  await execFileAsync('certutil', ['-user', '-addstore', 'Root', rootCertPath(caDir)])
}

export async function untrustCaInWindows(caDir: string): Promise<void> {
  const serial = await caSerialHex(caDir)
  await execFileAsync('certutil', ['-user', '-delstore', 'Root', serial])
}
