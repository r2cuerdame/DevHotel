import { describe, expect, it } from 'vitest'
import { zAgentAcquireRoomInput, zAgentCreateRoomInput } from '../control'

const base = { sourceType: 'empty', sourceRef: '', project: 'demo', nickname: 'dev' }
describe('Room acquire/create agent contract', () => {
  for (const schema of [zAgentAcquireRoomInput, zAgentCreateRoomInput]) {
    it('accepts stable task/issue IDs and refuses force flags and authority escalation', () => {
      expect(schema.parse({ ...base, taskId: ' task-97 ', issueRef: 'issue-97' })).toMatchObject({ taskId: 'task-97', issueRef: 'issue-97' })
      for (const extra of [{ taskId: ' ' }, { issueRef: '' }, { force: true }, { actor: 'user' }, { provider: 'windows' }, { sourceType: 'linked-folder', sourceRef: 'C:/secret' }]) {
        expect(schema.safeParse({ ...base, ...extra }).success).toBe(false)
      }
    })
  }
})
