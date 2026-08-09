const MASK = '•••'

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

export function redactSecrets(text: string, customPatterns: string[] = []): string {
  let out = text
  out = out.replace(PEM_BLOCK, '[private key redacted]')
  out = out.replace(KEYED_VALUE, `$1${MASK}`)
  out = out.replace(BEARER, `$1${MASK}`)
  out = out.replace(CONNECTION_STRING, `$1${MASK}$3`)
  for (const re of WELL_KNOWN_TOKENS) out = out.replace(re, MASK)
  out = out.replace(ENV_LINE, `$1${MASK}`)
  for (const pattern of customPatterns) {
    try {
      out = out.replace(new RegExp(pattern, 'gi'), MASK)
    } catch {
      // invalid user pattern — skip rather than fail the whole redaction
    }
  }
  return out
}
