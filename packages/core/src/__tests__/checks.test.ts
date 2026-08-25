import { describe, expect, it } from 'vitest'
import { runChecks, type CheckCtx } from '../checks/engine'
import { SCAN_SENTINEL } from '../checks/lineEndings'
import { FakeBackend, FakeGateway, listeningPort, makeRoom, tempDir } from './fakes'

function ctxWith(overrides: Partial<CheckCtx> = {}): CheckCtx {
  const backend = new FakeBackend()
  const gateway = new FakeGateway()
  return {
    room: makeRoom({ sourceType: 'empty', sourceRef: '', workspaceMode: 'empty', syncStatus: 'empty' }),
    backend,
    gateway: gateway.asGateway(),
    userData: tempDir(),
    depsGen: 0,
    syncRoute: async () => undefined,
    ...overrides
  }
}

describe('runChecks', () => {
  it('marks runtime-dependent steps unknown for a sleeping room', async () => {
    const ctx = ctxWith({
      room: makeRoom({ sourceType: 'empty', sourceRef: '', workspaceMode: 'empty', syncStatus: 'empty', status: 'sleeping', hostPort: null })
    })
    const report = await runChecks(ctx)
    const by = Object.fromEntries(report.results.map((r) => [r.step, r]))
    expect(by.backend!.status).toBe('healthy')
    expect(by.process!.status).toBe('unknown')
    expect(by.http!.status).toBe('unknown')
    expect(report.overall).toBe('healthy')
  })

  it('flags an exited web process as broken with a restart fix and overall broken', async () => {
    const backend = new FakeBackend()
    backend.webStateValue = 'exited'
    const ctx = ctxWith({
      backend,
      room: makeRoom({ sourceType: 'empty', sourceRef: '', workspaceMode: 'empty', syncStatus: 'empty', status: 'attention', hostPort: 45000 })
    })
    const report = await runChecks(ctx)
    const process = report.results.find((r) => r.step === 'process')!
    expect(process.status).toBe('broken')
    expect(process.fix).toEqual({ kind: 'restart-web' })
    expect(report.overall).toBe('broken')
  })

  it('reports a healthy running room end to end and self-heals a missing route', async () => {
    const { port, close } = await listeningPort()
    try {
      const gateway = new FakeGateway()
      const room = makeRoom({ sourceType: 'empty', sourceRef: '', workspaceMode: 'empty', syncStatus: 'empty', status: 'ready', hostPort: port })
      const ctx = ctxWith({
        gateway: gateway.asGateway(),
        room,
        syncRoute: async () => {
          await gateway.setRoute({ domain: room.domain, roomId: room.id, targetPort: port, https: false })
        }
      })
      const report = await runChecks(ctx)
      const by = Object.fromEntries(report.results.map((r) => [r.step, r]))
      expect(by.process!.status).toBe('healthy')
      expect(by.port!.status).toBe('healthy')
      expect(by.gateway!.status).toBe('healthy')
      expect(by.gateway!.summary).toMatch(/restored/)
    } finally {
      close()
    }
  })

  it('checks an Android Room end to end including the relayed emulator screen', async () => {
    const { port, close } = await listeningPort()
    try {
      const backend = new FakeBackend()
      backend.emulatorStateValue = 'running'
      backend.execInRoom = async (_roomId, cmd) => {
        const command = cmd.join(' ')
        if (command.includes('java -version')) {
          return { code: 0, stdout: 'openjdk version "17.0.12"\n', stderr: '' }
        }
        if (command.includes('Gradle Wrapper')) {
          return { code: 0, stdout: 'Gradle Wrapper', stderr: '' }
        }
        return { code: 1, stdout: '', stderr: 'unexpected command' }
      }
      const gateway = new FakeGateway()
      const room = makeRoom({
        provider: 'android',
        sourceType: 'empty',
        sourceRef: '',
        workspaceMode: 'empty',
        syncStatus: 'empty',
        runtime: { kind: 'jdk', version: '17' },
        packageManager: { kind: 'gradle' },
        internalPort: 6080,
        status: 'ready',
        hostPort: port
      })
      const report = await runChecks(
        ctxWith({
          backend,
          gateway: gateway.asGateway(),
          room,
          syncRoute: async () => {
            await gateway.setRoute({ domain: room.domain, roomId: room.id, targetPort: port, https: false })
          }
        })
      )
      const by = Object.fromEntries(report.results.map((result) => [result.step, result]))
      expect(by.metadata!.summary).toContain(room.domain)
      expect(by.runtime!.status).toBe('healthy')
      expect(by['package-manager']!.summary).toBe('Gradle Wrapper')
      expect(by.process!.summary).toBe('build container running')
      expect(by.port!.status).toBe('healthy')
      expect(by.port!.summary).toContain('emulator screen')
      expect(by.gateway!.summary).toMatch(/restored/)
      expect(by.http!.status).toBe('healthy')
      expect(report.overall).toBe('healthy')
    } finally {
      close()
    }
  })

  it('flags a missing emulator container on an awake Android Room', async () => {
    const backend = new FakeBackend()
    backend.emulatorStateValue = 'missing'
    backend.execInRoom = async () => ({ code: 0, stdout: 'ok', stderr: '' })
    const report = await runChecks(
      ctxWith({
        backend,
        room: makeRoom({
          provider: 'android',
          sourceType: 'empty',
          sourceRef: '',
          workspaceMode: 'empty',
          syncStatus: 'empty',
          runtime: { kind: 'jdk', version: '17' },
          packageManager: { kind: 'gradle' },
          internalPort: 6080,
          status: 'ready',
          hostPort: 45000
        })
      })
    )
    const port = report.results.find((result) => result.step === 'port')!
    expect(port.status).toBe('broken')
    expect(port.summary).toContain('emulator container missing')
  })
})

describe('line-endings check', () => {
  /** A Room that owns its workspace and is awake enough to be scanned. */
  function hotelRoom(backend: FakeBackend): CheckCtx {
    return ctxWith({
      backend,
      room: makeRoom({
        sourceType: 'linked-folder',
        sourceRef: 'D:\\Projects\\demo',
        workspaceMode: 'hotel',
        syncStatus: 'synced',
        status: 'ready',
        hostPort: 45000
      })
    })
  }

  it('names the CRLF scripts and offers the normalize fix', async () => {
    const backend = new FakeBackend()
    backend.execHandler = (cmd) =>
      cmd[2]?.includes(SCAN_SENTINEL)
        ? { code: 0, stdout: `${SCAN_SENTINEL}\0./gradlew\0./scripts/build.sh\0`, stderr: '' }
        : { code: 0, stdout: '', stderr: '' }
    const report = await runChecks(hotelRoom(backend))
    const result = report.results.find((r) => r.step === 'line-endings')!
    expect(result.status).toBe('broken')
    expect(result.summary).toContain('./gradlew')
    expect(result.detail).toContain('not a Gradle or build failure')
    expect(result.fix).toEqual({ kind: 'normalize-line-endings' })
    expect(report.overall).toBe('broken')
  })

  it('passes a workspace whose scripts already use LF', async () => {
    const backend = new FakeBackend()
    backend.execHandler = () => ({ code: 0, stdout: `${SCAN_SENTINEL}\0`, stderr: '' })
    const report = await runChecks(hotelRoom(backend))
    const result = report.results.find((r) => r.step === 'line-endings')!
    expect(result.status).toBe('healthy')
    expect(result.fix).toBeUndefined()
  })

  it('reports unknown rather than healthy when the scan could not run', async () => {
    const backend = new FakeBackend()
    backend.execHandler = () => ({ code: 1, stdout: '', stderr: 'exec failed' })
    const report = await runChecks(hotelRoom(backend))
    const result = report.results.find((r) => r.step === 'line-endings')!
    expect(result.status).toBe('unknown')
  })

  it('has nothing to scan in an empty room', async () => {
    const report = await runChecks(ctxWith())
    const result = report.results.find((r) => r.step === 'line-endings')!
    expect(result.status).toBe('healthy')
    expect(result.summary).toBe('no scripts in an empty room')
  })

  it('checks Android rooms too — the CRLF gradlew case that started this', async () => {
    const backend = new FakeBackend()
    backend.execHandler = (cmd) =>
      cmd[2]?.includes(SCAN_SENTINEL)
        ? { code: 0, stdout: `${SCAN_SENTINEL}\0./gradlew\0`, stderr: '' }
        : { code: 0, stdout: '', stderr: '' }
    const ctx = ctxWith({
      backend,
      room: makeRoom({
        provider: 'android',
        sourceType: 'linked-folder',
        sourceRef: 'D:\\Projects\\app',
        workspaceMode: 'hotel',
        syncStatus: 'synced',
        status: 'ready',
        hostPort: 45000,
        internalPort: 6080
      })
    })
    const report = await runChecks(ctx)
    const result = report.results.find((r) => r.step === 'line-endings')!
    expect(result.status).toBe('broken')
    expect(result.fix).toEqual({ kind: 'normalize-line-endings' })
  })
})

describe('line-endings check on a legacy Host bind', () => {
  it('names the Host-side fix instead of offering a Change that would be refused', async () => {
    const backend = new FakeBackend()
    backend.execHandler = () => ({ code: 0, stdout: `${SCAN_SENTINEL}\0./gradlew\0`, stderr: '' })
    // makeRoom() defaults to legacy-host-bind: the workspace is the user's folder
    const report = await runChecks(ctxWith({ backend, room: makeRoom({ status: 'ready', hostPort: 45000 }) }))
    const result = report.results.find((r) => r.step === 'line-endings')!
    expect(result.status).toBe('broken')
    expect(result.fix).toBeUndefined()
    expect(result.detail).toContain('still bound to its Host folder')
    expect(result.detail).toContain('.gitattributes')
  })
})
