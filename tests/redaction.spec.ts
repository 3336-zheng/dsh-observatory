import { describe, expect, it } from 'vitest'
import { redactValue } from '../src/redaction.ts'

describe('redactValue', () => {
  it('redacts secret fields, inline credentials, and user paths', () => {
    const result = redactValue({
      token: 'plain-secret',
      command: 'curl -H "Authorization: Bearer abc.def.ghi" /Users/alice/project',
      nested: { api_key: 'sk-abcdefghijklmnop' },
    })
    expect(result).toEqual({
      token: '[REDACTED]',
      command: 'curl -H "Authorization: [REDACTED]" /Users/[USER]/project',
      nested: { api_key: '[REDACTED]' },
    })
  })

  it('does not retain cyclic object references', () => {
    const value: Record<string, unknown> = {}
    value.self = value
    expect(redactValue(value)).toEqual({ self: '[CIRCULAR]' })
  })
})
