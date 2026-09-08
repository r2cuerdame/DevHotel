import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function sha256(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolveHash(hash.digest('hex')))
  })
}

/** Produce one detached release manifest and the matching installed resource. */
export default async function writePackagedBuildIdentity(context) {
  const identity = JSON.parse(readFileSync(resolve(desktopDir, 'out/main/build-identity.json'), 'utf8'))
  const appAsar = resolve(context.appOutDir, 'resources', 'app.asar')
  const manifest = { ...identity, appAsarSha256: await sha256(appAsar) }
  const json = `${JSON.stringify(manifest, null, 2)}\n`
  writeFileSync(resolve(context.appOutDir, 'resources', 'build-identity.json'), json, 'utf8')
  writeFileSync(resolve(context.outDir, 'build-identity.json'), json, 'utf8')
}
