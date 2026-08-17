/** Observatory 本地 .dsh 配置管理的跨 Host/Client 数据协议。 */
export type ConfigKind = 'skills' | 'mcp' | 'agents'

export interface ConfigFile {
  readonly id: string
  readonly kind: ConfigKind
  readonly relativePath: string
  readonly bytes: number
  readonly modifiedAt: number
  readonly format: 'markdown' | 'yaml' | 'json' | 'text'
}

export interface ConfigListValue {
  readonly root: string
  readonly files: readonly ConfigFile[]
}

export interface ConfigReadValue {
  readonly file: ConfigFile
  readonly content: string
  readonly redacted: boolean
}

export interface ConfigWriteRequest {
  readonly kind: ConfigKind
  readonly id: string
  readonly content: string
  readonly expectedModifiedAt?: number
}

export interface ConfigWriteValue {
  readonly file: ConfigFile
}
