import { en } from './en'
import { ko } from './ko'
import { ja } from './ja'
import { zhCN } from './zh-CN'
import { es } from './es'
import { fr } from './fr'
import { de } from './de'
import { ptBR } from './pt-BR'
import { ru } from './ru'

export type Translation = { [K in keyof typeof en]: string }

export type LocaleId = 'en' | 'ko' | 'ja' | 'zh-CN' | 'es' | 'fr' | 'de' | 'pt-BR' | 'ru'

export type TFunc = (key: keyof Translation, vars?: Record<string, string | number>) => string

export const LOCALES: { id: LocaleId; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'ko', label: '한국어' },
  { id: 'ja', label: '日本語' },
  { id: 'zh-CN', label: '简体中文' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
  { id: 'de', label: 'Deutsch' },
  { id: 'pt-BR', label: 'Português (Brasil)' },
  { id: 'ru', label: 'Русский' }
]

const DICTIONARIES: Record<LocaleId, Translation> = {
  en,
  ko,
  ja,
  'zh-CN': zhCN,
  es,
  fr,
  de,
  'pt-BR': ptBR,
  ru
}

export function isLocaleId(value: string): value is LocaleId {
  return LOCALES.some((l) => l.id === value)
}

export function detectLocale(): LocaleId {
  const raw = navigator.language || 'en'
  if (isLocaleId(raw)) return raw
  const prefix = raw.split('-')[0] ?? ''
  if (prefix === 'zh') return 'zh-CN'
  if (prefix === 'pt') return 'pt-BR'
  return isLocaleId(prefix) ? prefix : 'en'
}

export function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
}

export function translate(lang: LocaleId, key: keyof Translation, vars?: Record<string, string | number>): string {
  return format(DICTIONARIES[lang][key], vars)
}
