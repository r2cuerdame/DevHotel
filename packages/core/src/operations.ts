import { randomUUID } from 'node:crypto'
import type {
  Actor,
  OperationKind,
  OperationRecord,
  OperationStage,
  OperationStageKey
} from '@devhotel/shared'
import type { OperationsRepo } from './store/operationsRepo'

/** Longest server-side wait a caller may ask for on one call. */
export const MAX_OPERATION_WAIT_MS = 600_000

/**
 * What a running operation reports about itself. Stages are advisory progress,
 * never control flow: the work decides what happens, the reporter only records
 * where it got to so a caller who timed out can find out.
 */
export interface OperationReporter {
  /** Open a stage, closing the previous open one as `done`. */
  begin(key: OperationStageKey, label: string): void
  /** Attach detail to the open stage (kept when it closes). */
  detail(text: string): void
  /** Close the open stage as `skipped` — not done, but deliberately not fatal. */
  skip(detail: string): void
  /**
   * Record a terminal failure without throwing. Room wake handles its own
   * errors (the Room is marked broken rather than the call rejecting), so the
   * operation needs to be told the outcome explicitly.
   */
  fail(message: string, error?: unknown): void
}

export interface OperationHandle {
  /** Snapshot taken the moment the operation was created or joined. */
  record: OperationRecord
  /** Resolves when work and terminal persistence settle; rejects if either fails. */
  completion: Promise<void>
}

interface LiveOperation {
  record: OperationRecord
  settled: Promise<void>
  waiters: Set<() => void>
}

function nowIso(): string {
  return new Date().toISOString()
}

function clone(record: OperationRecord): OperationRecord {
  return {
    ...record,
    stages: record.stages.map((stage) => ({ ...stage })),
    error: record.error === null ? null : { ...record.error }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Tracks long operations by durable ID.
 *
 * Two properties matter to callers:
 * - **Joining, not duplicating.** Asking to start work that is already running
 *   returns the running operation. A client that retried after its own timeout
 *   never starts a second Room wake.
 * - **Answering after the fact.** Records are persisted, so a poll works after
 *   the operation finished, after the caller reconnected, and after the app
 *   restarted (interrupted records are failed at startup rather than left
 *   running forever).
 */
export class OperationTracker {
  private readonly live = new Map<string, LiveOperation>()
  private readonly runningByKey = new Map<string, string>()

  constructor(
    private readonly store: OperationsRepo,
    private readonly onUpdate?: (record: OperationRecord) => void
  ) {}

  /** Fails records left running by a previous process. Call once at startup. */
  recoverInterrupted(detail = 'DevHotel restarted while this operation was running'): OperationRecord[] {
    return this.store.failInterrupted(detail, nowIso())
  }

  get(id: string): OperationRecord | null {
    const live = this.live.get(id)
    return live ? clone(live.record) : this.store.get(id)
  }

  listForRoom(roomId: string, limit?: number): OperationRecord[] {
    return this.store.listForRoom(roomId, limit)
  }

  /** The running operation of this kind for this room, if there is one. */
  running(kind: OperationKind, roomId: string): OperationRecord | null {
    const id = this.runningByKey.get(`${kind}:${roomId}`)
    if (!id) return null
    const live = this.live.get(id)
    return live ? clone(live.record) : null
  }

  /**
   * Wait for an operation to reach a terminal status, bounded by `timeoutMs`.
   * A timeout is not an error: the current snapshot comes back with
   * `status: 'running'`, which is the whole point of the operation record.
   */
  async wait(id: string, timeoutMs: number): Promise<OperationRecord | null> {
    const bounded = Math.max(0, Math.min(timeoutMs, MAX_OPERATION_WAIT_MS))
    const live = this.live.get(id)
    if (!live) return this.get(id)
    if (bounded === 0) return clone(live.record)
    let timer: NodeJS.Timeout | undefined
    let release: (() => void) | undefined
    try {
      await Promise.race([
        live.settled.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, bounded)
          // A settled operation is removed from `live` before its waiters run,
          // so waiters exist only while there is still something to wait for.
          release = resolve
          live.waiters.add(resolve)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
      if (release) live.waiters.delete(release)
    }
    return this.get(id)
  }

  /**
   * Start `task`, or join the operation of the same kind already running for
   * this room. The returned record is available immediately — before the work
   * finishes — so the caller always has an ID to come back with.
   */
  run(
    kind: OperationKind,
    roomId: string,
    actor: Actor,
    task: (report: OperationReporter) => Promise<void>
  ): OperationHandle {
    const key = `${kind}:${roomId}`
    const existingId = this.runningByKey.get(key)
    const existing = existingId ? this.live.get(existingId) : undefined
    if (existing) return { record: clone(existing.record), completion: existing.settled }

    const startedAt = nowIso()
    const record: OperationRecord = {
      id: randomUUID(),
      kind,
      roomId,
      actor,
      status: 'running',
      stage: 'preparing',
      stages: [],
      error: null,
      startedAt,
      updatedAt: startedAt,
      finishedAt: null
    }
    // Durability is the publication boundary. If this save fails, no live key
    // is visible and no task is scheduled, so a retry can start cleanly rather
    // than joining an in-memory operation that never had any work behind it.
    this.persist(record)
    const entry: LiveOperation = { record, settled: Promise.resolve(), waiters: new Set() }
    this.live.set(record.id, entry)
    this.runningByKey.set(key, record.id)

    let failed = false
    const openStage = (): OperationStage | undefined => {
      const last = record.stages[record.stages.length - 1]
      return last?.status === 'running' ? last : undefined
    }
    const closeOpen = (status: OperationStage['status'], detail?: string): void => {
      const stage = openStage()
      if (!stage) return
      stage.status = status
      stage.endedAt = nowIso()
      if (detail !== undefined) stage.detail = detail
    }
    const touch = (): void => {
      record.updatedAt = nowIso()
      this.persist(record)
    }
    const report: OperationReporter = {
      begin: (stageKey, label) => {
        if (failed) return
        closeOpen('done')
        record.stages.push({
          key: stageKey,
          label,
          status: 'running',
          detail: null,
          startedAt: nowIso(),
          endedAt: null
        })
        record.stage = stageKey
        touch()
      },
      detail: (text) => {
        const stage = openStage()
        if (!stage) return
        stage.detail = text
        touch()
      },
      skip: (detail) => {
        if (failed) return
        closeOpen('skipped', detail)
        touch()
      },
      fail: (message, error) => {
        if (failed) return
        failed = true
        const detail = error === undefined ? message : `${message}: ${messageOf(error)}`
        closeOpen('failed', detail)
        record.error = { stage: record.stage, message: detail }
        touch()
      }
    }

    const settled = Promise.resolve()
      .then(() => task(report))
      .then(
        () => {
          this.finish(key, entry, failed ? null : undefined)
        },
        (error: unknown) => {
          this.finish(key, entry, messageOf(error))
          throw error
        }
      )
    entry.settled = settled
    // A caller may take the record and never await; the rejection is carried by
    // the operation record instead of becoming an unhandled rejection.
    void settled.catch(() => undefined)
    return { record: clone(record), completion: settled }
  }

  /** `failureMessage`: a string to fail with, null when already failed, undefined on success. */
  private finish(key: string, entry: LiveOperation, failureMessage: string | null | undefined): void {
    const { record } = entry
    const finishedAt = nowIso()
    const open = record.stages[record.stages.length - 1]
    if (failureMessage !== undefined) {
      if (failureMessage !== null) {
        if (open?.status === 'running') {
          open.status = 'failed'
          open.detail = failureMessage
          open.endedAt = finishedAt
        }
        record.error = { stage: record.stage, message: failureMessage }
      }
      record.status = 'failed'
    } else {
      if (open?.status === 'running') {
        open.status = 'done'
        open.endedAt = finishedAt
      }
      record.stages.push({
        key: 'complete',
        label: 'Complete',
        status: 'done',
        detail: null,
        startedAt: finishedAt,
        endedAt: finishedAt
      })
      record.stage = 'complete'
      record.status = 'succeeded'
    }
    record.updatedAt = finishedAt
    record.finishedAt = finishedAt
    let terminalStored = false
    let terminalSaveError: unknown
    try {
      this.persist(record)
      terminalStored = true
    } catch (error) {
      terminalSaveError = error
      const priorOutcome = record.status
      const persistenceDetail =
        `Operation reached ${priorOutcome}, but its terminal state could not be saved: ${messageOf(error)}`
      const complete = record.stages[record.stages.length - 1]
      if (complete?.key === 'complete' && complete.status === 'done') {
        complete.status = 'failed'
        complete.detail = persistenceDetail
      }
      record.status = 'failed'
      record.error = {
        stage: record.stage,
        message: record.error ? `${record.error.message}; ${persistenceDetail}` : persistenceDetail
      }
      record.updatedAt = nowIso()
      // A transient first failure can still leave a durable, honest terminal
      // record. If storage remains unavailable, the terminal snapshot stays in
      // memory for polling until restart recovery closes the durable row.
      try {
        this.persist(record)
        terminalStored = true
      } catch (retryError) {
        terminalSaveError = new AggregateError(
          [error, retryError],
          'Could not save the operation terminal state after a retry'
        )
      }
    }
    if (this.runningByKey.get(key) === record.id) this.runningByKey.delete(key)
    if (terminalStored) this.live.delete(record.id)
    for (const wake of [...entry.waiters]) wake()
    entry.waiters.clear()
    if (terminalSaveError) throw terminalSaveError
  }

  private persist(record: OperationRecord): void {
    this.store.save(record)
    this.onUpdate?.(clone(record))
  }
}
