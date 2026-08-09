import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import forge from 'node-forge'

const execFileAsync = promisify(execFile)

const CA_NAME = 'DevHotel Local CA'
const DAY_MS = 24 * 60 * 60 * 1000

export interface CaMaterial {
  certPem: string
  keyPem: string
  fingerprint256: string
}

function rootCertPath(caDir: string): string {
  return path.join(caDir, 'rootCA.pem')
}

function rootKeyPath(caDir: string): string {
  return path.join(caDir, 'rootCA.key')
}

// first hex digit forced to a low nibble so the DER integer stays positive
function randomSerial(): string {
  const hex = forge.util.bytesToHex(forge.random.getBytesSync(16))
  return '0' + hex.slice(1)
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

export async function ensureCa(caDir: string): Promise<CaMaterial> {
  await mkdir(caDir, { recursive: true })
  const certFile = rootCertPath(caDir)
  const keyFile = rootKeyPath(caDir)

  if ((await exists(certFile)) && (await exists(keyFile))) {
    const certPem = await readFile(certFile, 'utf8')
    const keyPem = await readFile(keyFile, 'utf8')
    const cert = forge.pki.certificateFromPem(certPem)
    return { certPem, keyPem, fingerprint256: fingerprintOf(cert) }
  }

  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 })
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
  await writeFile(certFile, certPem, 'utf8')
  await writeFile(keyFile, keyPem, 'utf8')
  return { certPem, keyPem, fingerprint256: fingerprintOf(cert) }
}

export async function issueLeafCert(
  caDir: string,
  domain: string
): Promise<{ keyPem: string; certPem: string }> {
  const certsDir = path.join(caDir, 'certs')
  await mkdir(certsDir, { recursive: true })
  const certFile = path.join(certsDir, `${domain}.pem`)
  const keyFile = path.join(certsDir, `${domain}.key`)

  if ((await exists(certFile)) && (await exists(keyFile))) {
    return { certPem: await readFile(certFile, 'utf8'), keyPem: await readFile(keyFile, 'utf8') }
  }

  const ca = await ensureCa(caDir)
  const caCert = forge.pki.certificateFromPem(ca.certPem)
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem)

  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 })
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
  await writeFile(certFile, certPem, 'utf8')
  await writeFile(keyFile, keyPem, 'utf8')
  return { certPem, keyPem }
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
