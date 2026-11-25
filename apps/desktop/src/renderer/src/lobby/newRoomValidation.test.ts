import { describe, expect, it } from 'vitest'
import { LOCALES, translate } from '../i18n'
import {
  NICKNAME_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  isNewRoomPlanReady,
  isNewRoomSourceReady,
  parseInternalPort,
  validateDomain,
  validateInternalPort,
  validateNickname,
  validateProjectName,
  validateRepoUrl
} from './newRoomValidation'

describe('newRoomValidation', () => {
  describe('internal port', () => {
    it('accepts integers from 1 through 65535', () => {
      expect(parseInternalPort(1)).toBe(1)
      expect(parseInternalPort(3000)).toBe(3000)
      expect(parseInternalPort(65535)).toBe(65535)
      expect(parseInternalPort('1')).toBe(1)
      expect(parseInternalPort('3000')).toBe(3000)
      expect(parseInternalPort('65535')).toBe(65535)
      expect(validateInternalPort(1)).toBeNull()
      expect(validateInternalPort(65535)).toBeNull()
      expect(validateInternalPort('8080')).toBeNull()
    })

    it('rejects empty, out-of-range, non-integer, and NaN values', () => {
      for (const invalid of [0, -1, 65536, 3000.5, Number.NaN, Number.POSITIVE_INFINITY, '', '   ', '0', '65536', '3000.5', '1e3', 'abc']) {
        expect(parseInternalPort(invalid)).toBeNull()
        expect(validateInternalPort(invalid)).toEqual({ key: 'wizard.invalidPort' })
      }
    })
  })

  describe('domain', () => {
    it('accepts lowercase alphanumeric hyphenated names ending in .localhost', () => {
      for (const valid of ['a.localhost', 'my-app.localhost', 'app-123.localhost', '0-9.localhost']) {
        expect(validateDomain(valid)).toBeNull()
      }
    })

    it('rejects missing .localhost, uppercase, leading/trailing hyphens, spaces, subdomains, and empty values', () => {
      for (const invalid of [
        '',
        '   ',
        'my-app',
        '.localhost',
        'My-App.localhost',
        '-app.localhost',
        'app-.localhost',
        'my_app.localhost',
        'a.b.localhost',
        'my-app.localhost ',
        'my-app.local'
      ]) {
        expect(validateDomain(invalid)).toEqual({ key: 'wizard.invalidDomain' })
      }
    })
  })

  describe('repository URL', () => {
    it('accepts https://, http://, and git@ prefixes within length bounds', () => {
      expect(validateRepoUrl('https://github.com/you/project')).toBeNull()
      expect(validateRepoUrl('http://localhost:3000/repo.git')).toBeNull()
      expect(validateRepoUrl('git@github.com:you/project.git')).toBeNull()
    })

    it('rejects empty, missing scheme, ssh://, and overly long URLs', () => {
      for (const invalid of ['', '   ', 'github.com/you/project', 'ftp://example.com/repo.git', `https://example.com/${'a'.repeat(4100)}`]) {
        expect(validateRepoUrl(invalid)).toEqual({ key: 'wizard.invalidRepoUrl' })
      }
    })
  })

  describe('project name and room nickname', () => {
    it('allows empty optional project name, rejects blank or >100 chars, and accepts <=100 chars', () => {
      expect(validateProjectName('')).toBeNull()
      expect(validateProjectName('', { required: true })).toEqual({ key: 'wizard.nameBlank' })
      expect(validateProjectName('   ')).toEqual({ key: 'wizard.nameBlank' })
      expect(validateProjectName('a'.repeat(PROJECT_NAME_MAX_LENGTH))).toBeNull()
      expect(validateProjectName(`  ${'a'.repeat(PROJECT_NAME_MAX_LENGTH)}  `)).toBeNull()
      expect(validateProjectName('a'.repeat(PROJECT_NAME_MAX_LENGTH + 1))).toEqual({
        key: 'wizard.nameTooLong',
        vars: { max: PROJECT_NAME_MAX_LENGTH }
      })
    })

    it('rejects empty, blank, or >60 char nicknames and accepts <=60 chars', () => {
      expect(validateNickname('')).toEqual({ key: 'wizard.nameBlank' })
      expect(validateNickname('   ')).toEqual({ key: 'wizard.nameBlank' })
      expect(validateNickname('dev')).toBeNull()
      expect(validateNickname('a'.repeat(NICKNAME_MAX_LENGTH))).toBeNull()
      expect(validateNickname(`  ${'a'.repeat(NICKNAME_MAX_LENGTH)}  `)).toBeNull()
      expect(validateNickname('a'.repeat(NICKNAME_MAX_LENGTH + 1))).toEqual({
        key: 'wizard.nameTooLong',
        vars: { max: NICKNAME_MAX_LENGTH }
      })
    })
  })

  describe('step readiness across room types', () => {
    it('blocks source step on invalid git URL, blank/long project, or blank/long nickname', () => {
      const base = {
        provider: 'web' as const,
        sourceType: 'managed-git' as const,
        sourceRef: 'https://github.com/you/project',
        project: '',
        nickname: 'dev',
        vmwareReady: false,
        hasVmwareTemplate: false,
        snapshot: ''
      }
      expect(isNewRoomSourceReady(base)).toBe(true)
      expect(isNewRoomSourceReady({ ...base, sourceRef: 'github.com/you/project' })).toBe(false)
      expect(isNewRoomSourceReady({ ...base, project: '   ' })).toBe(false)
      expect(isNewRoomSourceReady({ ...base, project: 'a'.repeat(101) })).toBe(false)
      expect(isNewRoomSourceReady({ ...base, nickname: '   ' })).toBe(false)
      expect(isNewRoomSourceReady({ ...base, nickname: 'a'.repeat(61) })).toBe(false)
      expect(isNewRoomSourceReady({ ...base, provider: 'android', sourceType: 'empty', sourceRef: '' })).toBe(true)
      expect(
        isNewRoomSourceReady({
          ...base,
          provider: 'windows',
          sourceType: 'empty',
          sourceRef: '',
          project: 'win-app',
          vmwareReady: true,
          hasVmwareTemplate: true,
          snapshot: 'clean'
        })
      ).toBe(true)
      expect(
        isNewRoomSourceReady({
          ...base,
          provider: 'windows',
          sourceType: 'empty',
          sourceRef: '',
          project: '',
          vmwareReady: true,
          hasVmwareTemplate: true,
          snapshot: 'clean'
        })
      ).toBe(false)
    })

    it('blocks web check-in on invalid port or domain while keeping android and windows behavior', () => {
      expect(
        isNewRoomPlanReady({
          provider: 'web',
          startCommand: 'npm run dev',
          internalPort: '3000',
          domain: 'my-app.localhost',
          hasVmwareTemplate: false,
          snapshot: ''
        })
      ).toBe(true)
      expect(
        isNewRoomPlanReady({
          provider: 'web',
          startCommand: 'npm run dev',
          internalPort: '',
          domain: 'my-app.localhost',
          hasVmwareTemplate: false,
          snapshot: ''
        })
      ).toBe(false)
      expect(
        isNewRoomPlanReady({
          provider: 'web',
          startCommand: 'npm run dev',
          internalPort: '65536',
          domain: 'my-app.localhost',
          hasVmwareTemplate: false,
          snapshot: ''
        })
      ).toBe(false)
      expect(
        isNewRoomPlanReady({
          provider: 'web',
          startCommand: 'npm run dev',
          internalPort: '3000',
          domain: 'bad-domain',
          hasVmwareTemplate: false,
          snapshot: ''
        })
      ).toBe(false)
      expect(
        isNewRoomPlanReady({
          provider: 'android',
          startCommand: './gradlew assembleDebug',
          internalPort: '',
          domain: '',
          hasVmwareTemplate: false,
          snapshot: ''
        })
      ).toBe(true)
      expect(
        isNewRoomPlanReady({
          provider: 'windows',
          startCommand: '',
          internalPort: '',
          domain: '',
          hasVmwareTemplate: true,
          snapshot: 'clean'
        })
      ).toBe(true)
    })
  })

  describe('i18n coverage', () => {
    it('provides non-empty localized copy across all 9 locales with examples and max interpolation', () => {
      for (const locale of LOCALES) {
        const portMsg = translate(locale.id, 'wizard.invalidPort')
        const domainMsg = translate(locale.id, 'wizard.invalidDomain')
        const repoMsg = translate(locale.id, 'wizard.invalidRepoUrl')
        const blankMsg = translate(locale.id, 'wizard.nameBlank')
        const longMsg = translate(locale.id, 'wizard.nameTooLong', { max: 60 })

        expect(portMsg).toContain('65535')
        expect(domainMsg).toContain('my-app.localhost')
        expect(repoMsg).toContain('https://')
        expect(repoMsg).toContain('git@')
        expect(blankMsg.length).toBeGreaterThan(0)
        expect(longMsg).toContain('60')
        expect(longMsg).not.toContain('{max}')
      }
    })
  })
})
