export interface RedactionOptions {
  readonly keys?: readonly string[]
  readonly redactPaths?: boolean
}

const DEFAULT_SECRET_KEYS = [
  'authorization',
  'api_key',
  'apikey',
  'cookie',
  'password',
  'private_key',
  'secret',
  'token',
]

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
  /\b(?:api[_-]?key|token|secret)\s*[=:]\s*["']?[^\s,"']{8,}/giu,
]

const UNIX_PATH = /(^|\s)(\/(?:Users|home)\/)[^/\s]+/gu
const WINDOWS_PATH = /(^|\s)([A-Za-z]:\\Users\\)[^\\\s]+/gu

function redactString(value: string, redactPaths: boolean): string {
  let redacted = value
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, '[REDACTED]')
  if (redactPaths) {
    redacted = redacted
      .replace(UNIX_PATH, (_match, leading: string, prefix: string) => `${leading}${prefix}[USER]`)
      .replace(WINDOWS_PATH, (_match, leading: string, prefix: string) => `${leading}${prefix}[USER]`)
  }
  return redacted
}

/**
 * 深度复制观测数据，并移除常见凭据和值中的密钥片段。
 * @param value 待导出的任意 JSON 兼容值。
 * @param options 自定义敏感字段和路径脱敏策略。
 * @returns 不与输入共享对象引用的脱敏结果。
 */
export function redactValue(value: unknown, options: RedactionOptions = {}): unknown {
  const secretKeys = new Set((options.keys ?? DEFAULT_SECRET_KEYS).map(key => key.toLowerCase()))
  const redactPaths = options.redactPaths ?? true
  const seen = new WeakMap<object, unknown>()

  const walk = (candidate: unknown): unknown => {
    if (typeof candidate === 'string') return redactString(candidate, redactPaths)
    if (candidate === null || typeof candidate !== 'object') return candidate
    const prior = seen.get(candidate)
    if (prior !== undefined) return '[CIRCULAR]'
    if (Array.isArray(candidate)) {
      const result: unknown[] = []
      seen.set(candidate, result)
      for (const item of candidate) result.push(walk(item))
      return result
    }
    const result: Record<string, unknown> = {}
    seen.set(candidate, result)
    for (const [key, nested] of Object.entries(candidate)) {
      result[key] = secretKeys.has(key.toLowerCase()) ? '[REDACTED]' : walk(nested)
    }
    return result
  }

  return walk(value)
}
