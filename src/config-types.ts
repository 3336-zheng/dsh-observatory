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

export interface ConfigCreateFile {
  readonly relativePath: string
  readonly content: string
}

export interface ConfigCreateRequest {
  readonly kind: ConfigKind
  readonly name: string
  readonly files: readonly ConfigCreateFile[]
}

export interface ConfigCreateValue {
  readonly files: readonly ConfigFile[]
}

export interface ConfigDeleteRequest {
  readonly kind: ConfigKind
  readonly id: string
}

export interface ConfigDeleteValue {
  readonly deleted: readonly string[]
}

export interface ConfigTestValue {
  readonly ok: boolean
  readonly checks: readonly { readonly label: string; readonly ok: boolean; readonly detail: string }[]
}

export interface ConfigTestRequest {
  readonly kind: ConfigKind
  readonly id?: string
  readonly name?: string
  readonly files?: readonly ConfigCreateFile[]
  readonly content?: string
}

export interface ConfigGenerateRequest {
  readonly kind: ConfigKind
  readonly prompt: string
  readonly provider?: string
  readonly model?: string
}

export interface ConfigGenerateValue {
  readonly files: readonly ConfigCreateFile[]
  readonly summary: string
}
