import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RoomOrchestrator } from '@devhotel/core'
import type { VolumeGcResult, VolumeReconciliationReport } from '@devhotel/shared'
import { startControlApi } from './controlApi'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function withApi(
  orch: Partial<RoomOrchestrator>,
  fn: (base: string, headers: Record<string, string>) => Promise<void>
): Promise<void> {
  const userData = mkdtempSync(join(tmpdir(), 'devhotel-control-volumes-'))
  roots.push(userData)
  const control = await startControlApi(orch as RoomOrchestrator, userData, 'test')
  try {
    await fn(`http://127.0.0.1:${control.info.port}`, { authorization: `Bearer ${control.info.token}` })
  } finally {
    control.stop()
  }
}

describe('agent control API storage volume endpoints (issue #63)', () => {
  it('GET /v1/storage/volumes returns volume reconciliation report', async () => {
    const fakeReport: Partial<VolumeReconciliationReport> = {
      totalDockerVolumes: 10,
      safeGcCandidateCount: 2,
      safeGcCandidateBytes: 5000,
      fencedVolumeCount: 4,
      retainedVolumeCount: 4,
      unownedVolumeCount: 0
    }
    const reconcileVolumes = vi.fn(async () => fakeReport as VolumeReconciliationReport)

    await withApi({ reconcileVolumes } as unknown as Partial<RoomOrchestrator>, async (base, headers) => {
      const res = await fetch(`${base}/v1/storage/volumes`, { headers })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.safeGcCandidateCount).toBe(2)
      expect(reconcileVolumes).toHaveBeenCalledTimes(1)
    })
  })

  it('POST /v1/storage/volumes/gc executes bounded dry-run or real GC', async () => {
    const fakeResult: Partial<VolumeGcResult> = {
      dryRun: true,
      deletedCount: 0,
      reclaimedBytes: 0,
      deletedVolumes: [],
      errors: []
    }
    const gcVolumes = vi.fn(async () => fakeResult as VolumeGcResult)

    await withApi({ gcVolumes } as unknown as Partial<RoomOrchestrator>, async (base, headers) => {
      const res = await fetch(`${base}/v1/storage/volumes/gc`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: true, maxVolumes: 25 })
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.dryRun).toBe(true)
      expect(gcVolumes).toHaveBeenCalledWith({ dryRun: true, maxVolumes: 25 })
    })
  })

  it('POST /v1/storage/volumes/gc defaults to dryRun: true when body is empty', async () => {
    const fakeResult: Partial<VolumeGcResult> = {
      dryRun: true,
      deletedCount: 0,
      reclaimedBytes: 0,
      deletedVolumes: [],
      errors: []
    }
    const gcVolumes = vi.fn(async () => fakeResult as VolumeGcResult)

    await withApi({ gcVolumes } as unknown as Partial<RoomOrchestrator>, async (base, headers) => {
      const res = await fetch(`${base}/v1/storage/volumes/gc`, {
        method: 'POST',
        headers
      })
      expect(res.status).toBe(200)
      expect(gcVolumes).toHaveBeenCalledWith({ dryRun: true, maxVolumes: 50 })
    })
  })
})
