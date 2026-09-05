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
  /** True only for the call that created and scheduled this operation. */
  newlyStarted: boolean
}

export interface OperationRunOptions {
  /** Client-assigned durable idempotency key. */
  operationId?: string
  /** Request identity that must match whenever operationId is reused. */
  requestKey?: string
  /** Room starts join by kind/Room; queued Android runs must remain distinct. */
  joinRunningByRoom?: boolean
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
    stages: record.stages.map((stage) => ({
      ...stage,
      ...(stage.warnings === undefined ? {} : { warnings: [...stage.warnings] })
    })),
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

  /** Forget any in-memory snapshots after the owning Room has been deleted. */
  forgetRoom(roomId: string): void {
    const forgotten = new Set<string>()
    for (const [id, live] of this.live) {
      if (live.record.roomId !== roomId) continue
      forgotten.add(id)
      this.live.delete(id)
      for (const wake of [...live.waiters]) wake()
      live.waiters.clear()
    }
    for (const [key, id] of this.runningByKey) {
      if (forgotten.has(id)) this.runningByKey.delete(key)
    }
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
    task: (report: OperationReporter) => Promise<void>,
    options: OperationRunOptions = {}
  ): OperationHandle {
    const { operationId, requestKey, joinRunningByRoom = true } = options
    if (operationId) {
      const liveById = this.live.get(operationId)
      const existingById = liveById?.record ?? this.store.get(operationId)
      if (existingById) {
        if (
          existingById.kind !== kind ||
          existingById.roomId !== roomId ||
          existingById.actor !== actor ||
          existingById.requestKey !== requestKey
        ) {
          throw new Error(`Operation ${operationId} already belongs to a different request`)
        }
        if (!liveById && existingById.status === 'running') {
          throw new Error(`Operation ${operationId} is recorded as running but is not owned by this DevHotel process`)
        }
        return {
          record: clone(existingById),
          completion: liveById?.settled ?? Promise.resolve(),
          newlyStarted: false
        }
      }
    }

    const id = operationId ?? randomUUID()
    const key = joinRunningByRoom ? `${kind}:${roomId}` : `${kind}:${roomId}:${id}`
    const existingId = this.runningByKey.get(key)
    const existing = existingId ? this.live.get(existingId) : undefined
    if (existing) return { record: clone(existing.record), completion: existing.settled, newlyStarted: false }

    const startedAt = nowIso()
    const record: OperationRecord = {
      id,
      kind,
      roomId,
      actor,
      ...(requestKey === undefined ? {} : { requestKey }),
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
    // Install the real completion promise before invoking task(). A task may
    // synchronously re-enter run() for the same key; that join must observe the
    // pending completion, never an already-resolved placeholder.
    let resolveSettled!: () => void
    let rejectSettled!: (error: unknown) => void
    const settled = new Promise<void>((resolve, reject) => {
      resolveSettled = resolve
      rejectSettled = reject
    })
    const entry: LiveOperation = { record, settled, waiters: new Set() }
    this.live.set(record.id, entry)
    this.runningByKey.set(key, record.id)

    let reportedFailure: string | undefined
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
      try {
        this.persist(record)
      } catch (error) {
        // Stage persistence is observability, never Room control flow. Keep
        // driving the task and carry the warning in the in-memory snapshot;
        // the next successful progress or terminal save makes it durable.
        const stage = record.stages[record.stages.length - 1]
        if (!stage) return
        const warning = `Progress tracking update failed: ${messageOf(error)}`
        if (!stage.warnings?.includes(warning)) {
          stage.warnings = [...(stage.warnings ?? []), warning]
        }
      }
    }
    const report: OperationReporter = {
      begin: (stageKey, label) => {
        if (reportedFailure !== undefined) return
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
        if (reportedFailure !== undefined) return
        const stage = openStage()
        if (!stage) return
        stage.detail = text
        touch()
      },
      skip: (detail) => {
        if (reportedFailure !== undefined) return
        closeOpen('skipped', detail)
        touch()
      },
      fail: (message, error) => {
        if (reportedFailure !== undefined) return
        // Keep the public snapshot coherent while the task performs any final
        // cleanup. The terminal status, failed stage, error and finishedAt are
        // published together by finish(); a poll must never see a running
        // operation that already carries a terminal error.
        reportedFailure = error === undefined ? message : `${message}: ${messageOf(error)}`
      }
    }

    let work: Promise<void>
    try {
      // Invoke the task synchronously so lifecycle wrappers can reserve their
      // room lock before run() returns. The work itself remains asynchronous.
      work = Promise.resolve(task(report))
    } catch (error) {
      work = Promise.reject(error)
    }
    void work.then(
      () => {
        try {
          this.finish(key, entry, reportedFailure)
          resolveSettled()
        } catch (error) {
          rejectSettled(error)
        }
      },
      (error: unknown) => {
        const thrown = messageOf(error)
        try {
          this.finish(
            key,
            entry,
            reportedFailure === undefined ? thrown : `${reportedFailure}; finalization failed: ${thrown}`
          )
        } catch (finishError) {
          rejectSettled(finishError)
          return
        }
        rejectSettled(error)
      }
    )
    // A caller may take the record and never await; the rejection is carried by
    // the operation record instead of becoming an unhandled rejection.
    void settled.catch(() => undefined)
    return { record: clone(record), completion: settled, newlyStarted: true }
  }

  /** `failureMessage` is defined for failure and omitted for success. */
  private finish(key: string, entry: LiveOperation, failureMessage: string | undefined): void {
    const { record } = entry
    const finishedAt = nowIso()
    const open = record.stages[record.stages.length - 1]
    if (failureMessage !== undefined) {
      if (open?.status === 'running') {
        open.status = 'failed'
        open.detail = failureMessage
        open.endedAt = finishedAt
      }
      record.error = { stage: record.stage, message: failureMessage }
      record.status = 'failed'
    } else {
      if (open?.status === 'running') {
        open.status = 'done'
        open.endedAt = finishedAt
      }
      // A task may provide a useful terminal label (for example, the exact
      // application that was verified). Preserve that completed stage instead
      // of appending a second generic completion marker.
      if (open?.key !== 'complete' || open.status !== 'done') {
        record.stages.push({
          key: 'complete',
          label: 'Complete',
          status: 'done',
          detail: null,
          startedAt: finishedAt,
          endedAt: finishedAt
        })
      }
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
