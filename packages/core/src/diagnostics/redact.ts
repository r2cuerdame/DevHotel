export const REDACTED_SECRET = '•••'

const MASK = REDACTED_SECRET

const KEYED_VALUE =
  /((?:password|passwd|pwd|secret|token|api[-_]?key|apikey|auth(?:orization)?|cookie|session[-_]?id|private[-_]?key|access[-_]?key|client[-_]?secret|credential)[a-z0-9_-]*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi

const BEARER = /((?:bearer|basic|token)\s+)[a-z0-9._~+/=-]{8,}/gi

const CONNECTION_STRING = /((?:postgres(?:ql)?|mysql|redis|rediss|mongodb(?:\+srv)?|amqp|mssql):\/\/[^:\s/]+:)([^@\s]+)(@)/gi

const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g

const WELL_KNOWN_TOKENS = [
  /\bsk-[a-zA-Z0-9_-]{16,}\b/g, // openai-style
  /\bsk-ant-[a-zA-Z0-9_-]{16,}\b/g, // anthropic
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // github classic
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // github fine-grained
  /\bxox[abps]-[A-Za-z0-9-]{10,}\b/g, // slack
  /\bAKIA[0-9A-Z]{16}\b/g, // aws access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g // jwt
]

/** `NAME=value` lines (env files / env dumps): keep the name, mask the value. */
const ENV_LINE = /^(\s*(?:export\s+)?[A-Z][A-Z0-9_]{1,}\s*=\s*)(.+)$/gm

/**
 * Pairing values are unusually easy to leak because the useful diagnostics
 * around them often contain ordinary-looking six digit numbers and ports.
 * Keep the context in the output, but never the value itself. Plain numbers
 * and ordinary application ports intentionally do not match these patterns.
 */
const PAIRING_KEYED_VALUE =
  /((?:"|')?\b(?:adb[\s_-]*)?pair(?:ing)?[\s_-]*(?:code|port|token|endpoint|address|service)(?:"|')?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi
const PAIRING_PROMPT = /(\benter\s+pairing\s+code\s*:\s*)(\S+)/gi
const ADB_PAIR_COMMAND = /(\badb(?:\.exe)?\s+pair\s+)(\S+)(?:\s+(\S+))?/gi
const PAIRING_MDNS_LINE = /^(\s*)\S+(\s+_adb-tls-pairing\._tcp\.?\s+)\S+\s*$/gim

const PAIRING_STRUCTURED_KEYS = new Set([
  'adbpaircode',
  'adbpairingaddress',
  'adbpairingcode',
  'adbpairingendpoint',
  'adbpairingport',
  'adbpairingservice',
  'adbpairingtoken',
  'paircode',
  'pairingaddress',
  'pairingcode',
  'pairingendpoint',
  'pairingport',
  'pairingservice',
  'pairingtoken'
])
const PAIRING_CONTAINER_KEYS = new Set(['adbpair', 'adbpairing', 'pair', 'pairing'])
const PAIRING_CHILD_SECRET_KEYS = new Set(['address', 'code', 'endpoint', 'port', 'service', 'token'])
// These response contracts carry encoded bytes rather than prose. Pattern
// replacement inside them corrupts the decoded file/image/output. Pairing-key
// masking above still wins before this exemption is considered.
const OPAQUE_BASE64_KEYS = new Set(['contentbase64', 'png'])

function isCanonicalBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function redactKnownPairingShapes(text: string): string {
  return text
    .replace(PAIRING_MDNS_LINE, `$1${MASK}$2${MASK}`)
    .replace(ADB_PAIR_COMMAND, (_match, prefix: string) => `${prefix}${MASK}`)
    .replace(PAIRING_PROMPT, `$1${MASK}`)
    .replace(PAIRING_KEYED_VALUE, `$1${MASK}`)
}

/**
 * Process-local exact-value registry for secrets whose shape is not safely
 * recognisable. Values are reference counted so overlapping pairing flows do
 * not prematurely remove each other's protection.
 */
export class SecretRedactor {
  private readonly sensitiveValues = new Map<string, number>()

  register(values: Iterable<string>): () => void {
    // Short network-advertised values could be chosen to redact ordinary log
    // vocabulary. Real pairing codes are six digits and endpoints/services are
    // longer, so six is the safe lower bound for an exact dynamic value.
    const registered = [...new Set([...values].filter((value) => value.length >= 6))]
    for (const value of registered) {
      this.sensitiveValues.set(value, (this.sensitiveValues.get(value) ?? 0) + 1)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      for (const value of registered) {
        const remaining = (this.sensitiveValues.get(value) ?? 1) - 1
        if (remaining <= 0) this.sensitiveValues.delete(value)
        else this.sensitiveValues.set(value, remaining)
      }
    }
  }

  redactText(text: string, customPatterns: string[] = []): string {
    let out = redactKnownPairingShapes(text)
    out = out.replace(PEM_BLOCK, '[private key redacted]')
    out = out.replace(KEYED_VALUE, `$1${MASK}`)
    out = out.replace(BEARER, `$1${MASK}`)
    out = out.replace(CONNECTION_STRING, `$1${MASK}$3`)
    for (const re of WELL_KNOWN_TOKENS) out = out.replace(re, MASK)
    out = out.replace(ENV_LINE, `$1${MASK}`)
    for (const value of [...this.sensitiveValues.keys()].sort((a, b) => b.length - a.length)) {
      out = out.replace(new RegExp(escapeRegExp(value), 'gi'), MASK)
    }
    for (const pattern of customPatterns) {
      try {
        out = out.replace(new RegExp(pattern, 'gi'), MASK)
      } catch {
        // invalid user pattern — skip rather than fail the whole redaction
      }
    }
    return out
  }

  redactStructured<T>(value: T, customPatterns: string[] = []): T {
    const seenPlain = new WeakMap<object, unknown>()
    const seenPairing = new WeakMap<object, unknown>()
    const visit = (current: unknown, key?: string, pairingContext = false): unknown => {
      const normalizedKey = key?.replace(/[^a-z0-9]/gi, '').toLowerCase()
      if (
        normalizedKey &&
        (PAIRING_STRUCTURED_KEYS.has(normalizedKey) ||
          (pairingContext && PAIRING_CHILD_SECRET_KEYS.has(normalizedKey)))
      ) {
        return MASK
      }
      if (typeof current === 'string') {
        if (normalizedKey && OPAQUE_BASE64_KEYS.has(normalizedKey) && isCanonicalBase64(current)) return current
        return this.redactText(current, customPatterns)
      }
      if (current === null || typeof current !== 'object') return current
      if (current instanceof Date || current instanceof Uint8Array) return current
      const childPairingContext = pairingContext || (normalizedKey !== undefined && PAIRING_CONTAINER_KEYS.has(normalizedKey))
      const seen = childPairingContext ? seenPairing : seenPlain
      const known = seen.get(current)
      if (known) return known
      if (Array.isArray(current)) {
        const out: unknown[] = []
        seen.set(current, out)
        for (const item of current) out.push(visit(item, undefined, childPairingContext))
        return out
      }
      const out: Record<string, unknown> = {}
      seen.set(current, out)
      for (const [childKey, child] of Object.entries(current)) {
        out[childKey] = visit(child, childKey, childPairingContext)
      }
      return out
    }
    return visit(value) as T
  }
}

export const secretRedactor = new SecretRedactor()

/** Register exact ephemeral values and return an idempotent release function. */
export function registerSensitiveSecrets(values: Iterable<string>): () => void {
  return secretRedactor.register(values)
}

export function redactSecrets(text: string, customPatterns: string[] = []): string {
  return secretRedactor.redactText(text, customPatterns)
}

/** Recursively redact strings and pairing-specific fields before serialization. */
export function redactStructuredSecrets<T>(value: T, customPatterns: string[] = []): T {
  return secretRedactor.redactStructured(value, customPatterns)
}
