import { describe, expect, it } from 'vitest'
import { runDocker } from '../backend/cli'
import { LINE_ENDING_NORMALIZE_SCRIPT } from '../checks/lineEndings'

const IMAGES = ['alpine', 'node:22-bookworm', 'debian:bookworm-slim']
const DECOY_COUNT = 64

function normalizationContract(): string {
  return [
    'set -eu',
    'mkdir -p /workspace /cache',
    `printf '#!/bin/sh\\r\\necho normalized\\r\\n' > /workspace/gradlew`,
    `printf 'outside-safe\\n' > /cache/protected`,
    'chmod 755 /workspace/gradlew',
    'i=1',
    `while [ "$i" -le ${DECOY_COUNT} ]; do`,
    '  ln -s /cache/protected "/workspace/gradlew.devhotel-lf.$i"',
    '  i=$((i + 1))',
    'done',
    'before_mode=$(stat -c %a /workspace/gradlew)',
    LINE_ENDING_NORMALIZE_SCRIPT,
    'after_mode=$(stat -c %a /workspace/gradlew)',
    '[ "$before_mode" = "$after_mode" ]',
    '[ "$(/workspace/gradlew)" = normalized ]',
    'CR=$(printf "\\r")',
    '! grep -q "$CR\\$" /workspace/gradlew',
    '[ "$(cat /cache/protected)" = outside-safe ]',
    `[ "$(find /workspace -name '*.devhotel-lf.*' -type l | wc -l | tr -d ' ')" = "${DECOY_COUNT}" ]`
  ].join('\n')
}

describe.skipIf(process.env.DEVHOTEL_CRLF_SMOKE !== '1')('line-ending normalization (real Docker)', () => {
  for (const image of IMAGES) {
    it(`normalizes safely with ${image}'s shell and tools`, async () => {
      const result = await runDocker(
        ['run', '--rm', '--network', 'none', image, 'sh', '-lc', normalizationContract()],
        { timeoutMs: 180_000 }
      )
      expect(result.code, result.stderr || result.stdout).toBe(0)
    }, 180_000)
  }
})
