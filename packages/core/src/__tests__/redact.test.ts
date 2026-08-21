import { describe, expect, it } from 'vitest'
import { redactSecrets, redactStructuredSecrets, registerSensitiveSecrets } from '../diagnostics/redact'

describe('redactSecrets', () => {
  it('masks key-value secrets in many syntaxes', () => {
    const input = [
      'DATABASE_PASSWORD=hunter2',
      'apiKey: "sk_live_abcdef123456"',
      "secret = 'shh-dont-tell'",
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    ].join('\n')
    const out = redactSecrets(input)
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('sk_live_abcdef123456')
    expect(out).not.toContain('shh-dont-tell')
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
    expect(out).toContain('DATABASE_PASSWORD')
  })

  it('masks connection-string passwords but keeps host info', () => {
    const out = redactSecrets('db: postgres://app:s3cr3tpw@localhost:5432/app')
    expect(out).not.toContain('s3cr3tpw')
    expect(out).toContain('postgres://app:•••@localhost:5432/app')
  })

  it('masks a credential pasted into a repository URL but keeps the repository', () => {
    const out = redactSecrets('clone https://me:github_pat_leaked_value@github.com/acme/private.git')
    expect(out).not.toContain('github_pat_leaked_value')
    expect(out).toContain('https://me:•••@github.com/acme/private.git')
  })

  it('masks well-known token shapes anywhere in text', () => {
    const out = redactSecrets(
      'log: using ghp_ABCDEFGHIJKLMNOPQRSTUVWX123456 and sk-ant-api03-secret-key-material-here plus AKIAIOSFODNN7EXAMPLE'
    )
    expect(out).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWX123456')
    expect(out).not.toContain('sk-ant-api03-secret-key-material-here')
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('masks every env-style value while keeping variable names visible', () => {
    const out = redactSecrets('NODE_ENV=production\nSTRIPE_KEY=sk_test_xyz\nPORT=3000')
    expect(out).toContain('NODE_ENV')
    expect(out).toContain('STRIPE_KEY')
    expect(out).not.toContain('production')
    expect(out).not.toContain('sk_test_xyz')
    expect(out).not.toContain('3000')
  })

  it('redacts PEM private keys entirely', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7bq\n-----END RSA PRIVATE KEY-----'
    const out = redactSecrets(`before\n${pem}\nafter`)
    expect(out).not.toContain('MIIEowIBAAKCAQEA7bq')
    expect(out).toContain('[private key redacted]')
  })

  it('applies custom patterns and survives invalid ones', () => {
    const out = redactSecrets('internal id ACME-9931 stays hidden', ['ACME-\\d+', '[invalid'])
    expect(out).not.toContain('ACME-9931')
  })

  it('masks common ADB pairing shapes without hiding unrelated numbers and application ports', () => {
    const input = [
      'Pairing code: 481516',
      'pairing_port=37117',
      '"adbPairingToken":"short-lived-token"',
      'adb pair 192.0.2.44:37117 481516',
      'Enter pairing code: 481516',
      'adb-private _adb-tls-pairing._tcp 192.0.2.44:37117',
      'build 481516 finished',
      'repairing code: 246810',
      'web server listening at localhost:3000'
    ].join('\n')

    const out = redactSecrets(input)
    expect(out).not.toMatch(/192\.0\.2\.44|37117|short-lived-token/)
    expect(out.match(/481516/g)).toHaveLength(1)
    expect(out).toContain('build 481516 finished')
    expect(out).toContain('repairing code: 246810')
    expect(out).toContain('localhost:3000')
  })

  it('redacts pairing fields recursively but preserves intended opaque capability IDs', () => {
    const confirmationToken = '11111111-2222-4333-8444-555555555555'
    const safe = redactStructuredSecrets({
      nested: {
        pairingCode: 481516,
        pairing_endpoint: '192.0.2.44:37117',
        ordinaryPort: 3000,
        confirmationToken
      },
      pairing: { code: 123456, port: 37117, status: 'waiting-for-consent' },
      detail: 'pairing token: top-secret'
    })

    expect(safe).toEqual({
      nested: {
        pairingCode: '•••',
        pairing_endpoint: '•••',
        ordinaryPort: 3000,
        confirmationToken
      },
      pairing: { code: '•••', port: '•••', status: 'waiting-for-consent' },
      detail: 'pairing token: •••'
    })

    const shared = { code: 654321, port: 37654 }
    const aliased = redactStructuredSecrets({ ordinary: shared, pairing: shared })
    expect(aliased).toEqual({
      ordinary: shared,
      pairing: { code: '•••', port: '•••' }
    })
  })

  it('preserves opaque base64 bytes while structured pairing fields still mask', () => {
    // This is valid base64 and deliberately contains an AWS-token-shaped
    // substring that normal prose redaction would replace.
    const encodedBytes = 'AKIAABCDEFGHIJKLMNOP'

    expect(redactStructuredSecrets({
      contentBase64: encodedBytes,
      nested: { png: encodedBytes },
      malformedPayload: { contentBase64: 'pairing code: 918274' },
      detail: encodedBytes,
      pairingCode: encodedBytes
    })).toEqual({
      contentBase64: encodedBytes,
      nested: { png: encodedBytes },
      malformedPayload: { contentBase64: 'pairing code: •••' },
      detail: '•••',
      pairingCode: '•••'
    })
  })

  it('reference-counts exact ephemeral values and releases them idempotently', () => {
    const endpoint = '192.0.2.88:38888'
    const first = registerSensitiveSecrets([endpoint])
    const second = registerSensitiveSecrets([endpoint])
    expect(redactSecrets(`trace ${endpoint}`)).toBe('trace •••')

    first()
    first()
    expect(redactSecrets(`trace ${endpoint}`)).toBe('trace •••')
    second()
    expect(redactSecrets(`trace ${endpoint}`)).toBe(`trace ${endpoint}`)
  })
})
