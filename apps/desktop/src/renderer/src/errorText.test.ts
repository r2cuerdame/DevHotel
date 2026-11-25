import { describe, expect, it } from 'vitest'
import { RENDERER_ERROR_PREFIX } from '@devhotel/shared'
import { describeError } from './errorText'
import { translate, type LocaleId, type TFunc } from './i18n'

const tFor = (lang: LocaleId): TFunc => (key, vars) => translate(lang, key, vars)
const en = tFor('en')

function invokeRejection(payload: object, channel = 'rooms:start'): Error {
  return new Error(`Error invoking remote method '${channel}': Error: ${RENDERER_ERROR_PREFIX}${JSON.stringify(payload)}`)
}

describe('describeError', () => {
  it('shows the reason and a translated recovery line without the Electron prefix', () => {
    const err = invokeRejection({ code: 'ROOM_NOT_RUNNING', message: 'Room is asleep', recoveryHint: 'Wake the Room first' })
    const text = describeError(err, en)
    expect(text).toBe('Room is asleep\nHow to fix: Wake the Room first')
    expect(text).not.toContain('Error invoking remote method')
    expect(text).not.toContain('rooms:start')
    expect(text).not.toContain(RENDERER_ERROR_PREFIX)
    expect(describeError(err, tFor('ko'))).toBe('Room is asleep\n고치는 방법: Wake the Room first')
  })

  it('shows only the reason when there is no recovery hint', () => {
    expect(describeError(invokeRejection({ code: 'BUSY', message: 'Room is busy' }), en)).toBe('Room is busy')
  })

  it('replaces input validation errors with one translated line', () => {
    const err = invokeRejection({ code: 'INVALID_INPUT' }, 'rooms:create')
    expect(describeError(err, en)).toBe(translate('en', 'error.invalidInput'))
    expect(describeError(err, tFor('ja'))).toBe(translate('ja', 'error.invalidInput'))
  })

  it('strips the Electron prefix from plain main-process errors', () => {
    const err = new Error("Error invoking remote method 'rooms:syncFromHost': Error: Select the same Local Folder originally assigned to this Room")
    expect(describeError(err, en)).toBe('Select the same Local Folder originally assigned to this Room')
  })

  it('keeps ordinary renderer errors and strings as they are', () => {
    expect(describeError(new Error('Clipboard unavailable'), en)).toBe('Clipboard unavailable')
    expect(describeError('network down', en)).toBe('network down')
  })

  it('never produces an empty message', () => {
    const unknown = translate('en', 'error.unknown')
    expect(describeError(new Error(''), en)).toBe(unknown)
    expect(describeError(undefined, en)).toBe(unknown)
    expect(describeError(new Error("Error invoking remote method 'rooms:start': Error: "), en)).toBe(unknown)
    expect(describeError(invokeRejection({ code: 'X', message: '' }), en)).toBe(unknown)
  })

  it('falls back to the raw text when the payload is malformed', () => {
    const text = `${RENDERER_ERROR_PREFIX}{not json`
    expect(describeError(new Error(text), en)).toBe(text)
  })
})
