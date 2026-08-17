import type { ConfigFile, ConfigKind, ConfigListValue, ConfigReadValue, ConfigWriteValue } from '../config-types.ts'

interface ClientRpcResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly message?: string }
}

interface ClientConnection {
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<ClientRpcResult>
  }
}

function valueOf<T>(result: ClientRpcResult, guard: (value: unknown) => value is T): T {
  if (!result.ok || !guard(result.value)) throw new Error(result.error?.message ?? '配置服务不可用')
  return result.value
}

function isConfigFile(value: unknown): value is ConfigFile {
  if (value === null || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row.id === 'string' && typeof row.relativePath === 'string'
    && typeof row.bytes === 'number' && typeof row.modifiedAt === 'number'
}

function isList(value: unknown): value is ConfigListValue {
  if (value === null || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row.root === 'string' && Array.isArray(row.files) && row.files.every(isConfigFile)
}

function isRead(value: unknown): value is ConfigReadValue {
  if (value === null || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row.content === 'string' && typeof row.redacted === 'boolean' && isConfigFile(row.file)
}

function isWrite(value: unknown): value is ConfigWriteValue {
  if (value === null || typeof value !== 'object') return false
  return isConfigFile((value as Record<string, unknown>).file)
}

/** 通过 Harness Host 通道读取和保存受限的 .dsh 配置文件。 */
export class ConfigSource {
  constructor(private readonly connection: ClientConnection) {}

  async list(kind: ConfigKind): Promise<ConfigListValue> {
    const result = await this.connection.rpc.call('/observatory', 'config/list', { args: { kind } })
    return valueOf(result, isList)
  }

  async read(kind: ConfigKind, id: string): Promise<ConfigReadValue> {
    const result = await this.connection.rpc.call('/observatory', 'config/read', { args: { kind, id } })
    return valueOf(result, isRead)
  }

  async write(kind: ConfigKind, id: string, content: string, expectedModifiedAt?: number): Promise<ConfigWriteValue> {
    const result = await this.connection.rpc.call('/observatory', 'config/write', {
      args: { kind, id, content, ...(expectedModifiedAt === undefined ? {} : { expectedModifiedAt }) },
    })
    return valueOf(result, isWrite)
  }
}

