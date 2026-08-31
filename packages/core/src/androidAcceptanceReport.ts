import {
  ANDROID_ACCEPTANCE_MARKDOWN_MAX_BYTES,
  ANDROID_ACCEPTANCE_REPORT_MAX_BYTES,
  zAndroidAcceptanceReport,
  zAndroidAcceptanceReportUnsigned,
  type AndroidAcceptanceReport,
  type AndroidAcceptanceReportSummary,
  type AndroidAcceptanceReportUnsigned
} from '@devhotel/shared'
import type { AndroidAcceptanceIntegrity } from './androidAcceptanceIntegrity'
import { redactStructuredSecrets } from './diagnostics/redact'

/** Stable JSON byte encoding used by durable keyed report seals. */
export function canonicalAcceptanceJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Acceptance report contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalAcceptanceJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalAcceptanceJson(item)}`)
    return `{${entries.join(',')}}`
  }
  throw new Error('Acceptance report contains an unsupported value')
}

export function acceptanceReportSize(report: AndroidAcceptanceReport): number {
  return Buffer.byteLength(JSON.stringify(report), 'utf8')
}

export function sealAndroidAcceptanceReport(
  value: AndroidAcceptanceReportUnsigned,
  integrity: AndroidAcceptanceIntegrity
): AndroidAcceptanceReport {
  const unsigned = zAndroidAcceptanceReportUnsigned.parse(redactStructuredSecrets(value))
  const report = zAndroidAcceptanceReport.parse({
    ...unsigned,
    seal: integrity.identify('report', canonicalAcceptanceJson(unsigned))
  })
  if (acceptanceReportSize(report) > ANDROID_ACCEPTANCE_REPORT_MAX_BYTES) {
    throw new Error('Android acceptance report exceeds its bounded receipt size')
  }
  return report
}

export function verifyAndroidAcceptanceReport(
  value: unknown,
  integrity: AndroidAcceptanceIntegrity
): AndroidAcceptanceReport {
  const report = zAndroidAcceptanceReport.parse(value)
  const { seal, ...rawUnsigned } = report
  const unsigned = zAndroidAcceptanceReportUnsigned.parse(rawUnsigned)
  if (!integrity.verify(seal, canonicalAcceptanceJson(unsigned))) {
    throw new Error('Android acceptance report keyed seal does not match')
  }
  if (acceptanceReportSize(report) > ANDROID_ACCEPTANCE_REPORT_MAX_BYTES) {
    throw new Error('Android acceptance report exceeds its bounded receipt size')
  }
  const redacted = zAndroidAcceptanceReport.parse(redactStructuredSecrets(report))
  if (canonicalAcceptanceJson(redacted) !== canonicalAcceptanceJson(report)) {
    throw new Error('Android acceptance report contains unsafe secret material')
  }
  return report
}

export function acceptanceReportSummary(report: AndroidAcceptanceReport): AndroidAcceptanceReportSummary {
  return {
    id: report.id,
    roomId: report.roomId,
    stage: report.stage,
    status: report.status,
    applicationId: report.applicationId,
    createdAt: report.createdAt,
    targetKind: report.target.kind,
    screenshotCount: report.screenshots.length,
    logCount: report.logs.length,
    seal: report.seal,
    sizeBytes: acceptanceReportSize(report)
  }
}

function cell(value: string | number | null): string {
  if (value === null) return '—'
  return String(value).replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('`', 'ˋ')
}

/** Bounded secret-safe Markdown suitable for a GitHub issue or pull request. */
export function androidAcceptanceReportMarkdown(report: AndroidAcceptanceReport): string {
  const lines = [
    `## Android acceptance report \`${report.id}\``,
    '',
    `- Status: **${report.status.toUpperCase()}** · stage \`${report.stage}\``,
    `- Report seal: \`${report.seal.value}\``,
    `- Room: \`${report.roomId}\` · state r${report.room.stateRevision} · workspace r${report.room.workspaceVolumeRevision}`,
    `- Source identity: \`${report.room.sourceIdentity.value}\``,
    `- Image: \`${cell(report.image.reference)}\` · \`${report.image.sha256}\``,
    `- App/build: \`${report.applicationId}\` · change \`${report.build.changeId}\` · APK \`${report.build.apkSha256}\``,
    `- Target: \`${report.target.kind}\` · device \`${cell(report.target.deviceId)}\` · Android \`${cell(report.target.androidVersion)}\` · API \`${report.target.apiLevel}\``,
    `- Lease identity: \`${cell(report.target.leaseIdentity?.value ?? null)}\``,
    `- App locale: \`${cell(report.locale.localeTags.join(', ') || 'system default')}\` · system \`${cell(report.locale.systemTag)}\` · API \`${report.locale.apiLevel}\``,
    `- Locale readiness: ${report.locale.readiness.consecutiveReadyChecks} stable checks in ${report.locale.readiness.attempts} attempts · PIDs \`${report.locale.readiness.pids.join(',')}\` · restored \`${report.locale.restored}\``,
    `- Locale process: \`${report.locale.process.beforePids.join(',') || 'none'}\` → \`${report.locale.process.afterPids.join(',')}\` · restarted \`${report.locale.process.restarted}\``,
    '',
    '### Steps',
    '',
    '| Step | Status | Screenshot refs | Log refs |',
    '| --- | --- | ---: | ---: |',
    ...report.steps.map((step) =>
      `| \`${cell(step.id)}\` | ${step.status.toUpperCase()} | ${step.evidence.screenshotArtifactIds.length} | ${step.evidence.logRunIds.length} |`
    ),
    '',
    '### Screenshot artifacts',
    '',
    '| Artifact ID | File | Locale | SHA-256 | Retrieval |',
    '| --- | --- | --- | --- | --- |',
    ...(report.screenshots.length > 0
      ? report.screenshots.map((artifact) =>
          `| \`${artifact.artifactId}\` | \`${cell(artifact.filename)}\` | \`${cell(artifact.locale.tag)}\` (${artifact.locale.scope}) | \`${artifact.sha256}\` | ` +
          `Control API \`${artifact.retrieval.controlApiPath}\`; MCP \`${artifact.retrieval.mcpTool}\` |`
        )
      : ['| — | — | — | — | — |']),
    '',
    '_Screenshot export destinations are not embedded because exports are not durable report evidence._',
    '',
    '### Retained log evidence',
    '',
    '| Run ID | Keyed identity | Bytes | Exit |',
    '| --- | --- | ---: | ---: |',
    ...(report.logs.length > 0
      ? report.logs.map((log) => `| \`${log.runId}\` | \`${log.identity.value}\` | ${log.sizeBytes} | ${log.code} |`)
      : ['| — | — | 0 | — |'])
  ]
  if (report.crash) {
    lines.push(
      '',
      '### Crash evidence',
      '',
      `- Run: \`${report.crash.runId}\``,
      `- Observed: \`${report.crash.observed}\``,
      `- Process transition: \`${report.crash.pidsBefore.join(',')}\` → \`${report.crash.pidsAfter.join(',') || 'none'}\``,
      `- Package-scoped log accounting: ${report.crash.log.returnedLines}/${report.crash.log.sourceLines} lines${report.crash.log.truncated ? ' (truncated)' : ''}`
    )
  }
  const markdown = `${lines.join('\n')}\n`
  if (Buffer.byteLength(markdown, 'utf8') > ANDROID_ACCEPTANCE_MARKDOWN_MAX_BYTES) {
    throw new Error('Android acceptance report Markdown exceeds its bounded size')
  }
  return markdown
}
