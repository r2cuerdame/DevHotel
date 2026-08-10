import type { ChangeEntry, CheckReport, GatewayStatusInfo, RoomRecord } from '@devhotel/shared'
import { redactSecrets } from './redact'

export interface DiagnosticInput {
  room: RoomRecord
  appVersion: string
  report: CheckReport | null
  recentChanges: ChangeEntry[]
  gateway: GatewayStatusInfo
  webLogTail: string[]
  customPatterns: string[]
}

const MARK: Record<string, string> = { healthy: '✓', warning: '△', broken: '✕', unknown: '?' }

export function buildDiagnostic(input: DiagnosticInput): string {
  const { room, report, recentChanges, gateway, webLogTail } = input
  const lines: string[] = []
  const push = (s = ''): void => {
    lines.push(s)
  }

  push('DevHotel Diagnostic Bundle')
  push()
  push('Room')
  push(`- Project: ${room.project}`)
  push(`- Nickname: ${room.nickname}`)
  push(`- Provider: Web Room (DevHotel ${input.appVersion})`)
  push(`- Status: ${room.status}`)
  push()
  push('Stack')
  push(`- Node: ${room.runtime.version}`)
  push(`- Package Manager: ${room.packageManager.kind}${room.packageManager.version ? ` ${room.packageManager.version}` : ''}`)
  push(`- Start Command: ${room.startCommand}`)
  push(
    `- Source: ${room.sourceType}${
      room.sourceType === 'managed-git'
        ? ` (${room.sourceRef})`
        : room.workspaceMode === 'legacy-host-bind'
          ? ' (legacy Host-bound compatibility mode)'
          : room.sourceType === 'linked-folder'
            ? ` (Room-owned; Host sync ${room.hostSyncEnabled ? 'enabled' : 'detached'})`
            : ''
    }`
  )
  push(`- Working state: ${room.workspaceMode} · r${room.stateRevision} · ${room.syncStatus}`)
  push()
  push('Routing')
  push(`- Internal: ${room.internalPort}`)
  push(`- URL: ${room.https ? 'https' : 'http'}://${room.domain}`)
  push(`- Gateway: ${gateway.running ? `http :${gateway.httpPort ?? '—'} / https :${gateway.httpsPort ?? '—'}` : 'offline'}`)
  push()
  push('Recent Changes')
  if (recentChanges.length === 0) push('- none')
  for (const c of recentChanges.slice(0, 6)) {
    push(`- ${c.title} (${c.actor}, ${c.status})`)
  }
  push()
  push('Checks Already Performed')
  if (!report) {
    push('- none recorded')
  } else {
    for (const r of report.results) {
      push(`${MARK[r.status] ?? '?'} ${r.step}: ${r.summary}`)
    }
  }
  const failing = report?.results.filter((r) => r.status === 'broken') ?? []
  if (failing.length > 0 || webLogTail.length > 0) {
    push()
    push('Failure')
    for (const f of failing) push(`- ${f.step}: ${f.summary}${f.detail ? ` — ${f.detail}` : ''}`)
    if (webLogTail.length > 0) {
      push('- Recent web output:')
      for (const line of webLogTail.slice(-40)) push(`  ${line}`)
    }
  }
  push()
  push('Question')
  push('Diagnose why this isolated web development environment fails to start or misbehaves, using the checks above.')

  return redactSecrets(lines.join('\n'), input.customPatterns)
}
