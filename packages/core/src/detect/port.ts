import type { Detected } from '@devhotel/shared'
import { FRAMEWORK_PORTS } from './framework'
import type { SourceReader } from './sourceReader'

const PORT_FLAG = /(?:^|\s)(?:-p|--port)(?:[=\s]+)(\d{1,5})(?=\s|$)/

export async function detectPort(
  _src: SourceReader,
  framework: string | null,
  startScript: string | undefined,
): Promise<Detected<number>> {
  if (startScript !== undefined) {
    const match = startScript.match(PORT_FLAG)
    if (match) return { value: Number.parseInt(match[1]!, 10), source: 'script flag' }
  }

  if (framework !== null) {
    const port = FRAMEWORK_PORTS[framework]
    if (port !== undefined) return { value: port, source: `framework (${framework})` }
  }

  return { value: 3000, source: 'default' }
}
