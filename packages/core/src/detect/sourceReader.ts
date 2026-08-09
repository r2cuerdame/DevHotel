import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface SourceReader {
  readFile(rel: string): Promise<string | null>
  exists(rel: string): Promise<boolean>
}

export function fsSourceReader(rootDir: string): SourceReader {
  return {
    async readFile(rel) {
      try {
        return await readFile(join(rootDir, rel), 'utf8')
      } catch {
        return null
      }
    },
    async exists(rel) {
      try {
        await access(join(rootDir, rel))
        return true
      } catch {
        return false
      }
    },
  }
}
