import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hashRuntimePayloads } from './runtime-payloads.mjs'

/** Add post-signing hashes for every runtime payload to the detached manifest. */
export default async function finalizePackagedBuildIdentity(context) {
  const unpacked = (await readdir(context.outDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('-unpacked'))
  if (unpacked.length !== 1) throw new Error('Expected exactly one unpacked application directory')

  const manifestFile = join(context.outDir, 'build-identity.json')
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  manifest.runtimePayloads = await hashRuntimePayloads(join(context.outDir, unpacked[0].name))
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return [manifestFile]
}
