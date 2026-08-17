import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import type { ConfigFile, ConfigKind, ConfigListValue, ConfigReadValue, ConfigWriteRequest, ConfigWriteValue } from './config-types.ts'

const MAX_FILE_BYTES = 512 * 1024
const MAX_FILES = 300
const SECRET_LINE = /^([ \t]*["']?[^:#\n]+?["']?[ \t]*:[ \t]*)(.*)$/
const SECRET_KEY = /(api[_-]?key|token|secret|password|authorization|private[_-]?key)/i
const ALLOWED_EXTENSIONS = new Set(['.md', '.yaml', '.yml', '.json', '.txt'])

interface HostConnection {
  readonly rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>,
      options: { readonly authority: 'trusted-host' | 'loopback' },
    ): () => Promise<void>
  }
}

interface RecordValue { readonly [key: string]: unknown }

function recordOf(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' ? value as RecordValue : {}
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function kindOf(value: unknown): ConfigKind | undefined {
  return value === 'skills' || value === 'mcp' || value === 'agents' ? value : undefined
}

function dshHome(): string {
  return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
}

function rootsFor(kind: ConfigKind): string[] {
  const home = dshHome()
  if (kind === 'skills') return [join(home, 'skills'), join(process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'), 'skills')]
  if (kind === 'mcp') return [join(home, 'mcp'), join(home, 'profiles')]
  return [join(home, '.agent-presets'), join(home, 'agents'), join(home, 'subagents')]
}

function rootLabel(kind: ConfigKind): string {
  return kind === 'skills' ? '.dsh/skills + .agents/skills'
    : kind === 'mcp' ? '.dsh/mcp + .dsh/profiles'
      : '.dsh/.agent-presets + .dsh/agents'
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep))
}

function extensionOf(path: string): ConfigFile['format'] {
  const extension = extname(path).toLowerCase()
  if (extension === '.md') return 'markdown'
  if (extension === '.json') return 'json'
  if (extension === '.yaml' || extension === '.yml') return 'yaml'
  return 'text'
}

function allowedFile(kind: ConfigKind, path: string): boolean {
  const normalized = path.split(sep).join('/')
  if (normalized.split('/').some(part => part === '.credentials.yaml' || part === 'credentials')) return false
  if (normalized.split('/').includes('node_modules')) return false
  if (!ALLOWED_EXTENSIONS.has(extname(path).toLowerCase())) return false
  if (kind === 'skills') return normalized.endsWith('/SKILL.md') || normalized === 'SKILL.md'
  if (kind === 'mcp' && isInside(join(dshHome(), 'profiles'), path)) {
    return new Set(['cordis.yml', 'cordis.yaml', 'cordis.patch.yml', 'cordis.patch.yaml', 'mcp.yml', 'mcp.yaml', 'mcp.json']).has(basename(path))
  }
  return true
}

function secretRedacted(kind: ConfigKind): boolean {
  return kind === 'mcp'
}

function redactMcp(content: string): string {
  return content.split('\n').map(line => {
    const match = line.match(SECRET_LINE)
    const prefix = match?.[1]
    const value = match?.[2]
    if (prefix === undefined || value === undefined || !SECRET_KEY.test(prefix) || value.trim() === '') return line
    return `${prefix}<redacted>`
  }).join('\n')
}

function restoreMcpSecrets(original: string, next: string): string {
  const before = original.split('\n')
  return next.split('\n').map((line, index) => {
    if (!line.includes('<redacted>')) return line
    const previous = before[index]
    return previous === undefined ? line : previous
  }).join('\n')
}

async function fileAt(kind: ConfigKind, id: string): Promise<{ path: string; file: ConfigFile }> {
  const path = resolve(dshHome(), id)
  if (!rootsFor(kind).some(root => isInside(resolve(root), path)) || !allowedFile(kind, path)) {
    throw new Error('不允许访问该配置文件')
  }
  const details = await stat(path)
  if (!details.isFile() || details.size > MAX_FILE_BYTES) throw new Error('配置文件不存在或超过大小限制')
  const relativePath = relative(dshHome(), path).split(sep).join('/')
  return {
    path,
    file: {
      id: relativePath,
      kind,
      relativePath,
      bytes: details.size,
      modifiedAt: details.mtimeMs,
      format: extensionOf(path),
    },
  }
}

async function walk(kind: ConfigKind, directory: string, files: ConfigFile[], depth: number): Promise<void> {
  if (depth > 5 || files.length >= MAX_FILES) return
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (files.length >= MAX_FILES || entry.name.startsWith('.DS_Store')) break
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await walk(kind, path, files, depth + 1)
      continue
    }
    if (!entry.isFile() || !allowedFile(kind, path)) continue
    try {
      const details = await stat(path)
      if (details.size > MAX_FILE_BYTES) continue
      const relativePath = relative(dshHome(), path).split(sep).join('/')
      files.push({
        id: relativePath,
        kind,
        relativePath,
        bytes: details.size,
        modifiedAt: details.mtimeMs,
        format: extensionOf(path),
      })
    } catch {
      // 文件可能在扫描期间被删除，跳过本次观察即可。
    }
  }
}

export async function listConfigFiles(kind: ConfigKind): Promise<ConfigListValue> {
  const files: ConfigFile[] = []
  for (const root of rootsFor(kind)) await walk(kind, root, files, 0)
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return { root: rootLabel(kind), files }
}

export async function readConfigFile(kind: ConfigKind, id: string): Promise<ConfigReadValue> {
  const resolved = await fileAt(kind, id)
  const content = await readFile(resolved.path, 'utf8')
  return {
    file: resolved.file,
    content: secretRedacted(kind) ? redactMcp(content) : content,
    redacted: secretRedacted(kind),
  }
}

export async function writeConfigFile(request: ConfigWriteRequest): Promise<ConfigWriteValue> {
  if (request.content.length > MAX_FILE_BYTES || request.content.includes('\0')) {
    throw new Error('配置内容为空或超过 512 KB 限制')
  }
  const resolved = await fileAt(request.kind, request.id)
  if (request.expectedModifiedAt !== undefined && Math.abs(resolved.file.modifiedAt - request.expectedModifiedAt) > 0.5) {
    throw new Error('文件已被其他程序修改，请重新读取后再保存')
  }
  const original = await readFile(resolved.path, 'utf8')
  const content = secretRedacted(request.kind) ? restoreMcpSecrets(original, request.content) : request.content
  await mkdir(resolve(resolved.path, '..'), { recursive: true })
  await writeFile(resolved.path, content, 'utf8')
  const updated = await fileAt(request.kind, request.id)
  return { file: updated.file }
}

export async function handleConfigRpc(endpoint: string, payload: unknown): Promise<unknown> {
  const args = recordOf(recordOf(payload).args)
  try {
    if (endpoint === 'config/list') {
      const kind = kindOf(args.kind)
      if (kind === undefined) throw new Error('无效的配置类型')
      return { ok: true, value: await listConfigFiles(kind) }
    }
    if (endpoint === 'config/read') {
      const kind = kindOf(args.kind)
      const id = stringOf(args.id)
      if (kind === undefined || id === undefined) throw new Error('无效的配置文件')
      return { ok: true, value: await readConfigFile(kind, id) }
    }
    if (endpoint === 'config/write') {
      const kind = kindOf(args.kind)
      const id = stringOf(args.id)
      const content = typeof args.content === 'string' ? args.content : undefined
      if (kind === undefined || id === undefined || content === undefined) throw new Error('无效的保存请求')
      return {
        ok: true,
        value: await writeConfigFile({
          kind,
          id,
          content,
          ...(typeof args.expectedModifiedAt === 'number' ? { expectedModifiedAt: args.expectedModifiedAt } : {}),
        }),
      }
    }
    return { ok: false, error: { code: 'not-found', message: '未知的 Observatory 配置接口' } }
  } catch (error) {
    return { ok: false, error: { code: 'config-rejected', message: error instanceof Error ? error.message : '配置操作失败' } }
  }
}

/** 在 Harness Host 上注册受限的 .dsh 配置通道。 */
export function installConfigRpc(ctx: { inject(keys: readonly string[], callback: (scope: { get(name: string): unknown }) => void): unknown }): void {
  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection') as HostConnection
    connection.rpc.handle('/observatory', handleConfigRpc, { authority: 'trusted-host' })
  })
}
