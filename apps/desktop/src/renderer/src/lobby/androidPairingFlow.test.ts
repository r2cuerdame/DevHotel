import { describe, expect, it } from 'vitest'
import {
  INITIAL_ANDROID_PAIRING_FLOW,
  androidPairingFlowReducer,
  clearPairingCodeInput,
  pairingCodeDigits,
  pairingRemainingSeconds,
  takePairingCode
} from './androidPairingFlow'

const CANDIDATE = {
  candidateId: '11111111-2222-4333-8444-555555555555',
  generation: 1,
  label: 'Wireless device 1',
  expiresAt: '2026-08-31T04:01:00.000Z'
}

describe('Android pairing consent flow', () => {
  it('cannot open a code prompt until the user selected a candidate and explicitly consented', () => {
    const choose = androidPairingFlowReducer(INITIAL_ANDROID_PAIRING_FLOW, {
      type: 'discovered',
      candidates: [CANDIDATE]
    })
    const selected = androidPairingFlowReducer(choose, { type: 'select', candidateId: CANDIDATE.candidateId })

    expect(androidPairingFlowReducer(selected, { type: 'open' })).toBe(selected)
    expect(androidPairingFlowReducer(selected, {
      type: 'opened',
      promptId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      expiresAt: CANDIDATE.expiresAt
    })).toBe(selected)

    const consented = androidPairingFlowReducer(selected, { type: 'consent', confirmed: true })
    const opening = androidPairingFlowReducer(consented, { type: 'open' })
    const prompt = androidPairingFlowReducer(opening, {
      type: 'opened',
      promptId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      expiresAt: CANDIDATE.expiresAt
    })
    expect(prompt.phase).toBe('prompt')
  })

  it('models expiry and one completion without any field capable of storing the pairing code', () => {
    const state = androidPairingFlowReducer(
      { ...INITIAL_ANDROID_PAIRING_FLOW, phase: 'prompt', promptId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      { type: 'expired' }
    )

    expect(state).toMatchObject({ phase: 'expired', promptId: null, resultCode: 'candidate-expired' })
    expect(Object.keys(state)).not.toContain('code')
    expect(JSON.stringify(state)).not.toContain('918274')
  })

  it('normalizes six input digits and exposes an honest expiry countdown', () => {
    expect(pairingCodeDigits(' 91-82a74 99')).toBe('918274')
    expect(pairingRemainingSeconds(CANDIDATE.expiresAt, Date.parse('2026-08-31T04:00:58.100Z'))).toBe(2)
    expect(pairingRemainingSeconds(CANDIDATE.expiresAt, Date.parse('2026-08-31T04:01:00.000Z'))).toBe(0)
  })

  it('takes one transient code copy and clears the uncontrolled input immediately', () => {
    const validInput = { value: ' 91-82a74 ' }
    expect(takePairingCode(validInput)).toBe('918274')
    expect(validInput.value).toBe('')

    const invalidInput = { value: '123' }
    expect(takePairingCode(invalidInput)).toBeNull()
    expect(invalidInput.value).toBe('')

    const dismissedInput = { value: '112358' }
    clearPairingCodeInput(dismissedInput)
    expect(dismissedInput.value).toBe('')
  })
})
