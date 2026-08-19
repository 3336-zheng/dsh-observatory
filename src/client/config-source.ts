import type {
  ConfigCreateFile, ConfigDeleteValue, ConfigFile, ConfigGenerateValue, ConfigKind, ConfigListValue,
  ConfigReadValue, ConfigTestValue, ConfigWriteValue,
} from '../config-types.ts'

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

function isFiles(value: unknown): value is { readonly files: readonly ConfigFile[] } {
  if (value === null || typeof value !== 'object') return false
  const files = (value as Record<string, unknown>).files
  return Array.isArray(files) && files.every(isConfigFile)
}

function isDelete(value: unknown): value is ConfigDeleteValue {
  return value !== null && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).deleted)
}

function isTest(value: unknown): value is ConfigTestValue {
  return value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>).ok === 'boolean'
    && Array.isArray((value as Record<string, unknown>).checks)
}

function isGenerate(value: unknown): value is ConfigGenerateValue {
  return value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>).summary === 'string'
    && Array.isArray((value as Record<string, unknown>).files)
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

  async create(kind: ConfigKind, name: string, files: readonly ConfigCreateFile[]): Promise<{ readonly files: readonly ConfigFile[] }> {
    const result = await this.connection.rpc.call('/observatory', 'config/create', { args: { kind, name, files } })
    return valueOf(result, isFiles)
  }

  async remove(kind: ConfigKind, id: string): Promise<ConfigDeleteValue> {
    const result = await this.connection.rpc.call('/observatory', 'config/delete', { args: { kind, id } })
    return valueOf(result, isDelete)
  }

  async test(kind: ConfigKind, input: { readonly id?: string; readonly files?: readonly ConfigCreateFile[]; readonly content?: string }): Promise<ConfigTestValue> {
    const result = await this.connection.rpc.call('/observatory', 'config/test', { args: { kind, ...input } })
    return valueOf(result, isTest)
  }

  async generate(kind: ConfigKind, prompt: string, route?: { readonly provider?: string; readonly model?: string }): Promise<ConfigGenerateValue> {
    const result = await this.connection.rpc.call('/observatory', 'config/generate', { args: { kind, prompt, ...route } })
    return valueOf(result, isGenerate)
  }
}
