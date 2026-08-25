import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import { FakeBackend, FakeGateway, FakeWindowsVm, tempDir, testDb } from './fakes'

describe('Windows VMware Room lifecycle', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function setup() {
    const userData = tempDir()
    dirs.push(userData)
    const db = testDb()
    const backend = new FakeBackend()
    const windowsVm = new FakeWindowsVm()
    const orch = new RoomOrchestrator({
      userData,
      backend,
      windowsVm,
      gateway: new FakeGateway().asGateway(),
      db,
      appVersion: 'test'
    })
    return { orch, backend, windowsVm, db }
  }

  it('creates, sleeps, wakes, resets, opens, checks and deletes without touching OCI', async () => {
    const { orch, backend, windowsVm, db } = setup()
    backend.health = async () => ({ ok: false, detail: 'Docker intentionally unavailable' })

    const created = await orch.createRoom({
      sourceType: 'empty',
      sourceRef: '',
      project: 'win-app',
      nickname: 'dev',
      actor: 'user',
      provider: 'windows',
      windows: { baseVmxPath: 'C:\\VMs\\Windows 11.vmx', snapshot: 'devhotel-clean' }
    })

    expect(created).toMatchObject({
      provider: 'windows',
      status: 'ready',
      runtime: { kind: 'windows', version: '11' },
      packageManager: { kind: 'none' },
      internalPort: 0,
      hostPort: null,
      windows: { backend: 'vmware', templateId: windowsVm.templateId, snapshot: 'devhotel-clean' }
    })
    expect(backend.calls).toEqual([])
    expect(windowsVm.calls).toEqual([
      'health',
      'inspectTemplate:devhotel-clean',
      `create:${created.id}:devhotel-clean`,
      `start:${created.id}`,
      `state:${created.id}`
    ])
    expect(orch.inspectRoom(created.id).urls.app).toBeNull()
    expect(orch.inspectRoom(created.id).stackLine).toMatch(/offline Clean Room/)

    await orch.sleepRoom(created.id, 'user')
    expect(orch.rooms.get(created.id)?.status).toBe('sleeping')
    await orch.startRoom(created.id, 'user')
    expect(orch.rooms.get(created.id)?.status).toBe('ready')
    await orch.openWindows(created.id, 'user')
    await orch.resetWindows(created.id, 'user')
    expect(orch.rooms.get(created.id)?.status).toBe('ready')
    expect(await orch.components(created.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'vmware' }), expect.objectContaining({ id: 'snapshot' })])
    )
    const report = await orch.runChecks(created.id)
    expect(report.results.find((result) => result.step === 'process')).toMatchObject({ status: 'healthy' })
    expect(report.results.find((result) => result.step === 'source')).toMatchObject({ status: 'healthy' })
    expect(() => orch.applyChange(created.id, { kind: 'node-version', version: '24' }, 'user')).toThrow(/guest agent/)

    const deleted = await orch.deleteRoom(created.id, 'user')
    expect(deleted.reclaimedBytes).toBe(2048)
    expect(orch.rooms.get(created.id)).toBeNull()
    expect(backend.calls).toEqual([])
    expect(windowsVm.calls).toContain(`openConsole:${created.id}`)
    expect(windowsVm.calls).toContain(`reset:${created.id}`)
    expect(windowsVm.calls).toContain(`delete:${created.id}`)
    db.close()
  })

  it('treats the VMware console as a user-only, journaled Host-input capability', async () => {
    const { orch, windowsVm, db } = setup()

    const created = await orch.createRoom({
      sourceType: 'empty',
      sourceRef: '',
      project: 'win-app',
      nickname: 'dev',
      actor: 'user',
      provider: 'windows',
      windows: { baseVmxPath: 'C:\\VMs\\Windows 11.vmx', snapshot: 'devhotel-clean' }
    })

    // The console window holds the real cursor and keyboard while it is
    // focused, so an Agent must never be able to open it.
    await expect(orch.openWindows(created.id, 'agent')).rejects.toThrow(/explicit user action/)
    await expect(orch.openWindows(created.id, 'devhotel')).rejects.toThrow(/explicit user action/)
    expect(windowsVm.calls).not.toContain(`openConsole:${created.id}`)

    await orch.openWindows(created.id, 'user')
    expect(windowsVm.calls).toContain(`openConsole:${created.id}`)
    // Observable after the fact: the takeover is in the Room's own log.
    expect(orch.logs.tail(created.id, 'orchestrator').join(' ')).toMatch(
      /VMware Workstation console.*Host cursor and keyboard/
    )

    db.close()
  })

  it('rejects unapproved actors and source-bearing Windows Rooms before materialization', async () => {
    const { orch, windowsVm, db } = setup()

    await expect(
      orch.createRoom({
        sourceType: 'empty',
        sourceRef: '',
        project: 'win-app',
        nickname: 'agent',
        actor: 'agent',
        provider: 'windows',
        windows: { baseVmxPath: 'C:\\VMs\\Windows 11.vmx', snapshot: 'devhotel-clean' }
      })
    ).rejects.toThrow(/user-approved/)
    await expect(
      orch.createRoom({
        sourceType: 'linked-folder',
        sourceRef: 'C:\\code\\win-app',
        project: 'win-app',
        nickname: 'dev',
        actor: 'user',
        provider: 'windows',
        windows: { baseVmxPath: 'C:\\VMs\\Windows 11.vmx', snapshot: 'devhotel-clean' }
      })
    ).rejects.toThrow(/currently start empty/)
    expect(windowsVm.calls).toEqual([])
    db.close()
  })

  it('plans only an empty Windows source and never enters the OCI source reader', async () => {
    const { orch, backend, db } = setup()

    await expect(
      orch.planRoom({
        sourceType: 'managed-git',
        sourceRef: 'https://example.test/repo.git',
        project: 'win-app',
        nickname: 'dev',
        provider: 'windows'
      })
    ).rejects.toThrow(/planning never imports/)
    const plan = await orch.planRoom({
      sourceType: 'empty',
      sourceRef: '',
      project: 'win-app',
      nickname: 'dev',
      provider: 'windows'
    })
    expect(plan.runtime.kind).toBe('windows')
    expect(backend.calls).toEqual([])
    db.close()
  })

  it('can delete a broken row when VMware failed before creating ownership', async () => {
    const { orch, windowsVm, db } = setup()
    windowsVm.failCreate = true
    const created = await orch.createRoom({
      sourceType: 'empty',
      sourceRef: '',
      project: 'win-app',
      nickname: 'broken',
      actor: 'user',
      provider: 'windows',
      windows: { baseVmxPath: 'C:\\VMs\\Windows 11.vmx', snapshot: 'devhotel-clean' }
    })

    expect(created.status).toBe('broken')
    await expect(orch.deleteRoom(created.id, 'user')).resolves.toEqual({ reclaimedBytes: 2048 })
    expect(orch.rooms.get(created.id)).toBeNull()
    expect(windowsVm.calls).not.toContain(`sleep:${created.id}`)
    db.close()
  })
})
