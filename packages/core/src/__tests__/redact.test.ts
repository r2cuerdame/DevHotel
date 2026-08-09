import { describe, expect, it } from 'vitest'
import { redactSecrets } from '../diagnostics/redact'

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
})
