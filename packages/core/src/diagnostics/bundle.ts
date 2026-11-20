import type { ChangeEntry, CheckReport, GatewayStatusInfo, RoomRecord } from '@devhotel/shared'
import { EMULATOR_DEFAULT_DEVICE, EMULATOR_DEFAULT_VERSION } from '../backend/naming'
import { redactSecrets } from './redact'

export interface DiagnosticInput {
  room: RoomRecord
  appVersion: string
  report: CheckReport | null
  recentChanges: ChangeEntry[]
  gateway: GatewayStatusInfo
  webLogTail: string[]
  orchestratorLogTail?: string[]
  customPatterns: string[]
}

const MARK: Record<string, string> = { healthy: '✓', warning: '△', broken: '✕', unknown: '?' }

const PROVIDER_LABEL: Record<RoomRecord['provider'], string> = {
  web: 'Web Room',
  android: 'Android Room',
  windows: 'Windows Room'
}

const QUESTION_BY_PROVIDER: Record<RoomRecord['provider'], string> = {
  web: 'Diagnose why this isolated web development environment fails to start or misbehaves, using the checks above.',
  android:
    'Diagnose why this isolated Android build and emulator environment fails to build, boot, or misbehaves, using the checks above.',
  windows:
    'Diagnose why this isolated offline Windows VMware environment fails to start, validate, or misbehaves, using the checks above.'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function linkedHostPathPatterns(room: RoomRecord): string[] {
  if (room.sourceType === 'managed-git') return []
  const ref = room.sourceRef.trim()
  if (ref.length < 4) return []
  const patterns = [escapeRegExp(ref)]
  const normalized = ref.replace(/\\/g, '/')
  if (normalized !== ref) patterns.push(escapeRegExp(normalized))
  return patterns
}

function describeSource(room: RoomRecord): string {
  if (room.sourceType === 'managed-git') return `${room.sourceType} (${room.sourceRef})`
  if (room.workspaceMode === 'legacy-host-bind') return `${room.sourceType} (legacy Host-bound compatibility mode)`
  if (room.sourceType === 'linked-folder') {
    return `${room.sourceType} (Room-owned; Host sync ${room.hostSyncEnabled ? 'enabled' : 'detached'})`
  }
  return room.sourceType
}

function formatGateway(gateway: GatewayStatusInfo): string {
  return gateway.running
    ? `http :${gateway.httpPort ?? '—'} / https :${gateway.httpsPort ?? '—'}`
    : 'offline'
}

export function buildDiagnostic(input: DiagnosticInput): string {
  const { room, report, recentChanges, gateway, webLogTail } = input
  const orchestratorLogTail = input.orchestratorLogTail ?? []
  const lines: string[] = []
  const push = (s = ''): void => {
    lines.push(s)
  }

  push('DevHotel Diagnostic Bundle')
  push()
  push('Room')
  push(`- Project: ${room.project}`)
  push(`- Nickname: ${room.nickname}`)
  push(`- Provider: ${PROVIDER_LABEL[room.provider]} (DevHotel ${input.appVersion})`)
  push(`- Status: ${room.status}`)
  push()

  if (room.provider === 'android') {
    const device = room.android?.device ?? EMULATOR_DEFAULT_DEVICE
    const version = room.android?.version ?? EMULATOR_DEFAULT_VERSION
    const resolution = room.android?.resolution ?? 'fast'
    const orientation = room.android?.orientation ?? 'portrait'

    push('Stack')
    push(`- JDK: ${room.runtime.version}`)
    push(
      `- Build Tool: ${room.packageManager.kind}${room.packageManager.version ? ` ${room.packageManager.version}` : ''}`
    )
    push(`- Build Command: ${room.startCommand}`)
    push(`- Emulator: ${device} · Android ${version} · ${resolution} · ${orientation}`)
    push(`- Source: ${describeSource(room)}`)
    push(`- Working state: ${room.workspaceMode} · r${room.stateRevision} · ${room.syncStatus}`)
    if (room.internalPort > 0 || room.domain) {
      push()
      push('Emulator Relay')
      if (room.internalPort > 0) push(`- Internal: ${room.internalPort}`)
      if (room.domain) push(`- Relay URL: ${room.https ? 'https' : 'http'}://${room.domain}`)
      push(`- Gateway: ${formatGateway(gateway)}`)
    }
  } else if (room.provider === 'windows') {
    const templateFingerprint = room.windows?.templateId ? room.windows.templateId.slice(0, 12) : 'missing'

    push('Environment')
    push(`- OS: Windows ${room.runtime.version}`)
    push(`- VM Backend: ${room.windows?.backend ?? 'missing'}`)
    push(`- Clean Snapshot: ${room.windows?.snapshot ?? 'missing'}`)
    push(`- Template Fingerprint: ${templateFingerprint}`)
  } else {
    push('Stack')
    push(`- Node: ${room.runtime.version}`)
    push(
      `- Package Manager: ${room.packageManager.kind}${room.packageManager.version ? ` ${room.packageManager.version}` : ''}`
    )
    push(`- Start Command: ${room.startCommand}`)
    push(`- Source: ${describeSource(room)}`)
    push(`- Working state: ${room.workspaceMode} · r${room.stateRevision} · ${room.syncStatus}`)
    push()
    push('Routing')
    push(`- Internal: ${room.internalPort}`)
    push(`- URL: ${room.https ? 'https' : 'http'}://${room.domain}`)
    push(`- Gateway: ${formatGateway(gateway)}`)
  }

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
  if (room.provider === 'web') {
    if (failing.length > 0 || webLogTail.length > 0) {
      push()
      push('Failure')
      for (const f of failing) push(`- ${f.step}: ${f.summary}${f.detail ? ` — ${f.detail}` : ''}`)
      if (webLogTail.length > 0) {
        push('- Recent web output:')
        for (const line of webLogTail.slice(-40)) push(`  ${line}`)
      }
      if (failing.length > 0 && orchestratorLogTail.length > 0) {
        push('- Recent orchestrator log:')
        for (const line of orchestratorLogTail.slice(-40)) push(`  ${line}`)
      }
    }
  } else {
    const includeContainerLog = room.provider === 'android' && webLogTail.length > 0
    if (failing.length > 0 || orchestratorLogTail.length > 0 || includeContainerLog) {
      push()
      push(failing.length > 0 ? 'Failure' : 'Recent Logs')
      for (const f of failing) push(`- ${f.step}: ${f.summary}${f.detail ? ` — ${f.detail}` : ''}`)
      if (orchestratorLogTail.length > 0) {
        push('- Recent orchestrator log:')
        for (const line of orchestratorLogTail.slice(-40)) push(`  ${line}`)
      }
      if (includeContainerLog) {
        push('- Recent container output:')
        for (const line of webLogTail.slice(-40)) push(`  ${line}`)
      }
    }
  }

  push()
  push('Question')
  push(QUESTION_BY_PROVIDER[room.provider])

  return redactSecrets(lines.join('\n'), [...input.customPatterns, ...linkedHostPathPatterns(room)])
}
