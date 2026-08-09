import { describe, expect, it } from 'vitest'
import { runChecks, type CheckCtx } from '../checks/engine'
import { FakeBackend, FakeGateway, listeningPort, makeRoom, tempDir } from './fakes'

function ctxWith(overrides: Partial<CheckCtx> = {}): CheckCtx {
  const backend = new FakeBackend()
  const gateway = new FakeGateway()
  return {
    room: makeRoom({ sourceType: 'empty', sourceRef: '' }),
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
    const ctx = ctxWith({ room: makeRoom({ sourceType: 'empty', sourceRef: '', status: 'sleeping', hostPort: null }) })
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
    const ctx = ctxWith({ backend, room: makeRoom({ sourceType: 'empty', sourceRef: '', status: 'attention', hostPort: 45000 }) })
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
      const room = makeRoom({ sourceType: 'empty', sourceRef: '', status: 'ready', hostPort: port })
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
})
