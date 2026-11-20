import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { RoomRecord } from '@devhotel/shared'

const copyDiagnostic = vi.fn(async () => undefined)
const runChecks = vi.fn(async () => null)
const applyChange = vi.fn(async () => undefined)
const roomAction = vi.fn(async () => undefined)

vi.mock('../../state/store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      runChecks,
      applyChange,
      roomAction,
      copyDiagnostic,
      inspections: {}
    }),
  useT: () => (key: string) => key
}))

import { DiagnosticsTab } from './Diagnostics'

function makeWindowsRoom(): RoomRecord {
  return {
    id: 'winroom1',
    project: 'win-qa',
    nickname: 'clean',
    roomNumber: 205,
    provider: 'windows',
    sourceType: 'empty',
    sourceRef: '',
    workspaceMode: 'empty',
    stateRevision: 0,
    workspaceVolumeRevision: 0,
    syncStatus: 'empty',
    lastSyncedAt: null,
    hostSyncEnabled: false,
    workspaceFingerprint: null,
    runtime: { kind: 'windows', version: '11' },
    packageManager: { kind: 'none' },
    startCommand: 'VMware guest boot',
    internalPort: 0,
    domain: 'win-qa-clean.localhost',
    https: false,
    status: 'ready',
    services: {},
    os: { env: {} },
    windows: {
      backend: 'vmware',
      snapshot: 'devhotel-clean',
      templateId: 'a'.repeat(64)
    },
    hostPort: null,
    createdAt: '2026-11-20T00:00:00.000Z',
    lastUsedAt: '2026-11-20T00:00:00.000Z',
    thumbPath: null
  }
}

describe('DiagnosticsTab', () => {
  it('renders Copy diagnostic button and copy hint for Windows Rooms', () => {
    const html = renderToStaticMarkup(<DiagnosticsTab room={makeWindowsRoom()} />)

    expect(html).toContain('diag.runChecks')
    expect(html).toContain('diag.copyDiagnostic')
    expect(html).toContain('diag.copyHint')
  })
})
