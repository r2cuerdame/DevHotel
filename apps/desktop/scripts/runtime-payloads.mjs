import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const SHA256 = /^[a-f0-9]{64}$/
const IGNORED = new Set([
  'LICENSE.electron.txt',
  'LICENSES.chromium.html',
  'resources/build-identity.json'
])

function normalized(relativePath) {
  return relativePath.split(sep).join('/')
}

function ignored(relativePath) {
  return IGNORED.has(relativePath) || relativePath === 'Uninstall DevHotel.exe'
}

async function sha256(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function filesBelow(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolute = join(directory, entry.name)
    const relativePath = normalized(relative(root, absolute))
    if (entry.isDirectory()) {
      files.push(...await filesBelow(root, absolute))
    } else if (entry.isFile()) {
      if (!ignored(relativePath)) files.push({ path: relativePath, absolute })
    } else {
      throw new Error('runtime payload mismatch')
    }
  }
  return files
}

export function validateRuntimePayloads(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 512) {
    throw new Error('invalid runtime payload manifest')
  }
  let previous = ''
  return value.map((entry) => {
    if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string' ||
        entry.path.includes('\\') || entry.path.startsWith('/') || entry.path.split('/').some((part) => !part || part === '.' || part === '..') ||
        !SHA256.test(entry.sha256) || entry.path <= previous) {
      throw new Error('invalid runtime payload manifest')
    }
    previous = entry.path
    return { path: entry.path, sha256: entry.sha256 }
  })
}

export async function hashRuntimePayloads(root) {
  const canonicalRoot = await realpath(root)
  const files = (await filesBelow(canonicalRoot)).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return Promise.all(files.map(async (file) => {
    const canonicalFile = await realpath(file.absolute)
    const prefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`
    if (!canonicalFile.startsWith(prefix)) throw new Error('runtime payload mismatch')
    return { path: file.path, sha256: await sha256(canonicalFile) }
  }))
}
