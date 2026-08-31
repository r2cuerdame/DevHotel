import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RoomOrchestrator } from '@devhotel/core'
import { startControlApi } from './controlApi'

const roots: string[] = []
const REPORT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const ARTIFACT_ID = '11111111-2222-4333-8444-555555555555'
const result = {
  report: {
    id: REPORT_ID,
    roomId: 'aaaa1111',
    status: 'pass',
    seal: { domain: 'report', value: 'a'.repeat(64) }
  },
  markdown: '## Android acceptance report\n'
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function controlFor(overrides: Record<string, unknown>) {
  const userData = mkdtempSync(join(tmpdir(), 'devhotel-control-acceptance-'))
  roots.push(userData)
  return startControlApi(overrides as unknown as RoomOrchestrator, userData, 'test')
}

describe('Android acceptance report control API', () => {
  it('creates, lists, and reads Room-scoped reports through strict routes', async () => {
    const createAndroidAcceptanceReport = vi.fn(async () => result)
    const listAndroidAcceptanceReports = vi.fn(() => [{ id: REPORT_ID, status: 'pass' }])
    const getAndroidAcceptanceReport = vi.fn(() => result)
    const control = await controlFor({
      createAndroidAcceptanceReport,
      listAndroidAcceptanceReports,
      getAndroidAcceptanceReport
    })
    const headers = {
      authorization: `Bearer ${control.info.token}`,
      'content-type': 'application/json'
    }
    const base = `http://127.0.0.1:${control.info.port}/v1/rooms/aaaa1111/android/acceptance-reports`
    const body = {
      applicationId: 'com.example.app',
      steps: [{ id: 'login', status: 'pass', screenshotArtifactIds: [ARTIFACT_ID] }]
    }
    try {
      const created = await fetch(base, { method: 'POST', headers, body: JSON.stringify(body) })
      expect(created.status).toBe(201)
      await expect(created.json()).resolves.toEqual(result)
      expect(createAndroidAcceptanceReport).toHaveBeenCalledWith(
        'aaaa1111',
        { ...body, stage: 'development' },
        'agent'
      )

      const listed = await fetch(`${base}?limit=5`, { headers })
      expect(listed.status).toBe(200)
      await expect(listed.json()).resolves.toEqual({ reports: [{ id: REPORT_ID, status: 'pass' }] })
      expect(listAndroidAcceptanceReports).toHaveBeenCalledWith('aaaa1111', 5)

      const fetched = await fetch(`${base}/${REPORT_ID}`, { headers })
      expect(fetched.status).toBe(200)
      await expect(fetched.json()).resolves.toEqual(result)
      expect(getAndroidAcceptanceReport).toHaveBeenCalledWith('aaaa1111', REPORT_ID)
    } finally {
      control.stop()
    }
  })

  it('rejects mixed stages, unknown fields, repeated query fields, and oversized bodies before Core', async () => {
    const createAndroidAcceptanceReport = vi.fn()
    const listAndroidAcceptanceReports = vi.fn()
    const control = await controlFor({ createAndroidAcceptanceReport, listAndroidAcceptanceReports })
    const headers = {
      authorization: `Bearer ${control.info.token}`,
      'content-type': 'application/json'
    }
    const base = `http://127.0.0.1:${control.info.port}/v1/rooms/aaaa1111/android/acceptance-reports`
    try {
      const invalid = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          applicationId: 'com.example.app',
          stage: 'final-physical',
          steps: [{ id: 'login', status: 'pass', screenshotArtifactIds: [ARTIFACT_ID] }],
          rawLeaseCapability: 'must-not-echo'
        })
      })
      expect(invalid.status).toBe(400)
      const invalidJson = await invalid.json() as { code: string; error: string }
      expect(invalidJson).toMatchObject({ code: 'INVALID_ANDROID_REQUEST' })
      expect(JSON.stringify(invalidJson)).not.toContain('must-not-echo')

      const repeated = await fetch(`${base}?limit=1&limit=2`, { headers })
      expect(repeated.status).toBe(400)
      await expect(repeated.json()).resolves.toMatchObject({ code: 'INVALID_ACCEPTANCE_QUERY' })

      const oversized = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({ padding: 'x'.repeat(70 * 1024) })
      })
      expect(oversized.status).toBe(413)
      await expect(oversized.json()).resolves.toMatchObject({ code: 'REQUEST_BODY_TOO_LARGE' })
      expect(createAndroidAcceptanceReport).not.toHaveBeenCalled()
      expect(listAndroidAcceptanceReports).not.toHaveBeenCalled()
    } finally {
      control.stop()
    }
  })
})
