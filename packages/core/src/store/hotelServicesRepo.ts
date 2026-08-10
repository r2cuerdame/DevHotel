import { randomUUID } from 'node:crypto'
import {
  zHotelServiceAssignmentInput,
  zHotelServiceManifest,
  zHotelServiceRegistrationInput,
  zHotelServiceStatePatch,
  type HotelServiceAssignment,
  type HotelServiceAssignmentInput,
  type HotelServiceInjection,
  type HotelServiceRecord,
  type HotelServiceRegistrationInput,
  type HotelServiceStatePatch
} from '@devhotel/shared'
import type { Db } from './db'

interface ServiceRow {
  id: string
  manifest_json: string
  availability: string
  registration_state: string
  provision_state: string
  connection_state: string
  enabled: number
  status_detail: string | null
  created_at: string
  updated_at: string
}

interface AssignmentRow {
  id: string
  service_id: string
  scope_kind: string
  scope_ref: string | null
  agent_adapter_id: string
  enabled: number
  created_at: string
  updated_at: string
}

interface InjectionRow {
  id: string
  assignment_id: string
  relative_path: string
  managed_key: string
  content_hash: string
  created_at: string
  updated_at: string
}

type AssignmentKey = Pick<HotelServiceAssignmentInput, 'serviceId' | 'scopeKind' | 'scopeRef' | 'agentAdapterId'>

function toService(row: ServiceRow): HotelServiceRecord {
  return {
    manifest: zHotelServiceManifest.parse(JSON.parse(row.manifest_json)),
    availability: row.availability as HotelServiceRecord['availability'],
    registrationState: row.registration_state as HotelServiceRecord['registrationState'],
    provisionState: row.provision_state as HotelServiceRecord['provisionState'],
    connectionState: row.connection_state as HotelServiceRecord['connectionState'],
    enabled: row.enabled === 1,
    statusDetail: row.status_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

const toAssignment = (row: AssignmentRow): HotelServiceAssignment => ({
  id: row.id,
  serviceId: row.service_id,
  scopeKind: row.scope_kind as HotelServiceAssignment['scopeKind'],
  scopeRef: row.scope_ref,
  agentAdapterId: row.agent_adapter_id,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

const toInjection = (row: InjectionRow): HotelServiceInjection => ({
  id: row.id,
  assignmentId: row.assignment_id,
  relativePath: row.relative_path,
  managedKey: row.managed_key,
  contentHash: row.content_hash,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

function assignmentWhere(key: AssignmentKey): [string, string, string | null, string] {
  return [key.serviceId, key.scopeKind, key.scopeRef, key.agentAdapterId]
}

export interface HotelServicesRepo {
  list(): HotelServiceRecord[]
  get(id: string): HotelServiceRecord | null
  register(input: HotelServiceRegistrationInput): HotelServiceRecord
  updateState(id: string, patch: HotelServiceStatePatch): HotelServiceRecord
  getAssignment(key: AssignmentKey): HotelServiceAssignment | null
  assign(input: HotelServiceAssignmentInput): HotelServiceAssignment
  removeAssignment(id: string): void
  getInjection(assignmentId: string): HotelServiceInjection | null
  saveInjection(assignmentId: string, relativePath: string, managedKey: string, contentHash: string): HotelServiceInjection
  removeInjection(assignmentId: string): void
}

export function hotelServicesRepo(db: Db): HotelServicesRepo {
  const { sqlite } = db
  return {
    list: () => (sqlite.prepare('SELECT * FROM hotel_services ORDER BY enabled DESC, id').all() as unknown as ServiceRow[]).map(toService),
    get(id) {
      const row = sqlite.prepare('SELECT * FROM hotel_services WHERE id = ?').get(id) as unknown as ServiceRow | undefined
      return row ? toService(row) : null
    },
    register(rawInput) {
      const input = zHotelServiceRegistrationInput.parse(rawInput)
      const existing = this.get(input.manifest.id)
      if (existing && existing.manifest.adapterId !== input.manifest.adapterId) {
        throw new Error(`Hotel Service adapter collision for ${input.manifest.id}`)
      }
      const now = new Date().toISOString()
      sqlite.prepare(`INSERT INTO hotel_services
        (id, manifest_json, availability, registration_state, provision_state, connection_state, enabled, status_detail, created_at, updated_at)
        VALUES (?, ?, ?, 'registered', 'not-provisioned', ?, ?, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET manifest_json=excluded.manifest_json,
          availability=excluded.availability, registration_state='registered', updated_at=excluded.updated_at`)
        .run(input.manifest.id, JSON.stringify(input.manifest), input.availability, input.initialConnectionState, input.enabled ? 1 : 0, now, now)
      return this.get(input.manifest.id)!
    },
    updateState(id, rawPatch) {
      const patch = zHotelServiceStatePatch.parse(rawPatch)
      const current = this.get(id)
      if (!current) throw new Error(`Hotel Service is not registered: ${id}`)
      const next = { ...current, ...patch }
      if (next.connectionState === 'connected' && next.provisionState !== 'provisioned') {
        throw new Error('A Hotel Service cannot be connected before it is provisioned')
      }
      if (next.registrationState === 'unregistered' && (next.enabled || next.connectionState === 'connected')) {
        throw new Error('An unregistered Hotel Service cannot remain enabled or connected')
      }
      const columns: Record<keyof HotelServiceStatePatch, string> = {
        availability: 'availability',
        registrationState: 'registration_state',
        provisionState: 'provision_state',
        connectionState: 'connection_state',
        enabled: 'enabled',
        statusDetail: 'status_detail'
      }
      const entries = Object.entries(patch).filter((entry) => entry[1] !== undefined) as [
        keyof HotelServiceStatePatch,
        HotelServiceStatePatch[keyof HotelServiceStatePatch]
      ][]
      const assignments = entries.map(([key]) => `${columns[key]} = ?`)
      const values = entries.map(([key, value]) => {
        if (value === undefined) throw new Error(`Undefined Hotel Service state: ${key}`)
        return typeof value === 'boolean' ? (value ? 1 : 0) : value
      })
      sqlite.prepare(`UPDATE hotel_services SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...values, new Date().toISOString(), id)
      return this.get(id)!
    },
    getAssignment(key) {
      const row = sqlite.prepare(`SELECT * FROM hotel_service_assignments
        WHERE service_id = ? AND scope_kind = ? AND scope_ref IS ? AND agent_adapter_id = ?`)
        .get(...assignmentWhere(key)) as unknown as AssignmentRow | undefined
      return row ? toAssignment(row) : null
    },
    assign(rawInput) {
      const input = zHotelServiceAssignmentInput.parse(rawInput)
      const service = this.get(input.serviceId)
      if (!service || service.registrationState !== 'registered') throw new Error('Hotel Service is not registered')
      if (!service.manifest.supportedContexts.includes(input.scopeKind)) {
        throw new Error(`Hotel Service does not support ${input.scopeKind} assignments`)
      }
      const existing = this.getAssignment(input)
      if (existing) {
        if (existing.enabled !== input.enabled) {
          sqlite.prepare('UPDATE hotel_service_assignments SET enabled = ?, updated_at = ? WHERE id = ?')
            .run(input.enabled ? 1 : 0, new Date().toISOString(), existing.id)
        }
        return this.getAssignment(input)!
      }
      const id = randomUUID(), now = new Date().toISOString()
      sqlite.prepare(`INSERT INTO hotel_service_assignments
        (id, service_id, scope_kind, scope_ref, room_id, agent_adapter_id, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          id,
          input.serviceId,
          input.scopeKind,
          input.scopeRef,
          input.scopeKind === 'room' ? input.scopeRef : null,
          input.agentAdapterId,
          input.enabled ? 1 : 0,
          now,
          now
        )
      return this.getAssignment(input)!
    },
    removeAssignment: (id) => { sqlite.prepare('DELETE FROM hotel_service_assignments WHERE id = ?').run(id) },
    getInjection(assignmentId) {
      const row = sqlite.prepare('SELECT * FROM hotel_service_injections WHERE assignment_id = ?').get(assignmentId) as unknown as InjectionRow | undefined
      return row ? toInjection(row) : null
    },
    saveInjection(assignmentId, relativePath, managedKey, contentHash) {
      if (!/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,512}$/.test(relativePath)) throw new Error('Invalid managed injection path')
      if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(managedKey)) throw new Error('Invalid managed injection key')
      if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('Invalid managed injection content hash')
      const current = this.getInjection(assignmentId)
      const now = new Date().toISOString(), id = current?.id ?? randomUUID()
      sqlite.prepare(`INSERT INTO hotel_service_injections
        (id, assignment_id, relative_path, managed_key, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(assignment_id) DO UPDATE SET relative_path=excluded.relative_path, managed_key=excluded.managed_key,
          content_hash=excluded.content_hash, updated_at=excluded.updated_at`)
        .run(id, assignmentId, relativePath, managedKey, contentHash, current?.createdAt ?? now, now)
      return this.getInjection(assignmentId)!
    },
    removeInjection: (assignmentId) => { sqlite.prepare('DELETE FROM hotel_service_injections WHERE assignment_id = ?').run(assignmentId) }
  }
}
