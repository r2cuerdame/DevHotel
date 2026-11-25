import { zCreateRoomInput, zLocalDomain, zNickname } from '@devhotel/shared'
import type { ProviderKind, SourceType } from '@devhotel/shared'
import type { Translation } from '../i18n'

export type CreatableProvider = Extract<ProviderKind, 'web' | 'android' | 'windows'>

export interface ValidationMessage {
  key: keyof Translation
  vars?: Record<string, string | number>
}

export const PROJECT_NAME_MAX_LENGTH = 100
export const NICKNAME_MAX_LENGTH = 60

const zProjectName = zCreateRoomInput.shape.project
const zSourceRef = zCreateRoomInput.shape.sourceRef
const zInternalPort = zCreateRoomInput.shape.planOverrides.unwrap().shape.internalPort.unwrap()
const REPO_URL_PREFIX = /^(https?:\/\/|git@)/

export function parseInternalPort(value: string | number): number | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^\d+$/.test(trimmed)) return null
    const parsed = Number(trimmed)
    return zInternalPort.safeParse(parsed).success ? parsed : null
  }
  return zInternalPort.safeParse(value).success ? value : null
}

export function validateInternalPort(value: string | number): ValidationMessage | null {
  return parseInternalPort(value) === null ? { key: 'wizard.invalidPort' } : null
}

export function validateDomain(value: string): ValidationMessage | null {
  return zLocalDomain.safeParse(value).success ? null : { key: 'wizard.invalidDomain' }
}

export function validateRepoUrl(value: string): ValidationMessage | null {
  if (!REPO_URL_PREFIX.test(value) || !zSourceRef.safeParse(value).success) {
    return { key: 'wizard.invalidRepoUrl' }
  }
  return null
}

export function validateProjectName(value: string, options?: { required?: boolean }): ValidationMessage | null {
  if (!options?.required && value === '') return null
  if (zProjectName.safeParse(value).success) return null
  if (value.trim().length === 0) return { key: 'wizard.nameBlank' }
  return { key: 'wizard.nameTooLong', vars: { max: PROJECT_NAME_MAX_LENGTH } }
}

export function validateNickname(value: string): ValidationMessage | null {
  if (zNickname.safeParse(value).success) return null
  if (value.trim().length === 0) return { key: 'wizard.nameBlank' }
  return { key: 'wizard.nameTooLong', vars: { max: NICKNAME_MAX_LENGTH } }
}

export function isNewRoomSourceReady(input: {
  provider: CreatableProvider
  sourceType: SourceType
  sourceRef: string
  project: string
  nickname: string
  vmwareReady: boolean
  hasVmwareTemplate: boolean
  snapshot: string
}): boolean {
  if (validateNickname(input.nickname) !== null) return false
  if (validateProjectName(input.project, { required: input.provider === 'windows' }) !== null) return false
  if (input.provider === 'windows') {
    return Boolean(input.vmwareReady && input.hasVmwareTemplate && input.snapshot)
  }
  if (input.sourceType === 'empty') return true
  if (input.sourceType === 'managed-git') return validateRepoUrl(input.sourceRef) === null
  return input.sourceRef.length > 2
}

export function isNewRoomPlanReady(input: {
  provider: CreatableProvider
  startCommand: string
  internalPort: string | number
  domain: string
  hasVmwareTemplate: boolean
  snapshot: string
}): boolean {
  if (input.provider === 'windows') {
    return Boolean(input.hasVmwareTemplate && input.snapshot)
  }
  if (!input.startCommand) return false
  if (input.provider === 'web') {
    return validateInternalPort(input.internalPort) === null && validateDomain(input.domain) === null
  }
  return true
}
