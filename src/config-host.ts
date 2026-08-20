import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import type {
  ConfigCreateFile, ConfigCreateRequest, ConfigCreateValue, ConfigDeleteRequest, ConfigDeleteValue,
  ConfigFile, ConfigGenerateRequest, ConfigGenerateValue, ConfigKind, ConfigListValue, ConfigReadValue,
  ConfigTestRequest, ConfigTestValue, ConfigWriteRequest, ConfigWriteValue,
} from './config-types.ts'

const MAX_FILE_BYTES = 512 * 1024
const MAX_FILES = 300
const SECRET_LINE = /^([ \t]*["']?[^:#\n]+?["']?[ \t]*:[ \t]*)(.*)$/
const SECRET_KEY = /(api[_-]?key|token|secret|password|authorization|private[_-]?key)/i
const ALLOWED_EXTENSIONS = new Set(['.md', '.yaml', '.yml', '.json', '.txt'])
const COMPONENT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const MAX_PROMPT_CHARS = 4_000
const MAX_GENERATED_CHARS = 64_000

interface HostConnection {
  readonly rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>,
      options: { readonly authority: 'trusted-host' | 'loopback' },
    ): () => Promise<void>
  }
}

interface HostLlm {
  stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>>
}

interface ConfigRuntime {
  readonly llm?: HostLlm
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

function managedRoot(kind: ConfigKind): string {
  const home = dshHome()
  if (kind === 'skills') return join(home, 'skills')
  if (kind === 'mcp') return join(home, 'mcp')
  return join(home, '.agent-presets')
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

function safeName(value: unknown): string {
  const name = stringOf(value)?.trim().toLowerCase()
  if (name === undefined || !COMPONENT_NAME.test(name)) throw new Error('名称只能使用小写字母、数字和短横线')
  return name
}

function relativeInside(root: string, candidate: string): string {
  const path = resolve(candidate)
  if (!isInside(resolve(root), path) || path === resolve(root)) throw new Error('不允许访问该组件目录')
  return relative(resolve(root), path).split(sep).join('/')
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

function createFilesFor(kind: ConfigKind, name: string, files: readonly ConfigCreateFile[]): ConfigCreateFile[] {
  if (files.length === 0 || files.length > 8) throw new Error('至少需要一个配置文件，最多 8 个')
  return files.map(file => {
    const relativePath = file.relativePath.replaceAll('\\', '/').replace(/^\/+/, '')
    if (relativePath === '' || relativePath.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error('配置文件路径无效')
    const path = resolve(managedRoot(kind), name, relativePath)
    if (!isInside(resolve(managedRoot(kind), name), path) || !allowedFile(kind, path)) throw new Error('配置文件类型或路径不允许')
    if (file.content.length > MAX_FILE_BYTES || file.content.includes('\0')) throw new Error('配置内容超过 512 KB 限制')
    return { relativePath, content: file.content }
  })
}

async function createConfig(request: ConfigCreateRequest): Promise<ConfigCreateValue> {
  const name = safeName(request.name)
  const files = createFilesFor(request.kind, name, request.files)
  const directory = join(managedRoot(request.kind), name)
  try {
    await stat(directory)
    throw new Error('同名组件已存在')
  } catch (error) {
    if (error instanceof Error && error.message === '同名组件已存在') throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(directory, { recursive: true })
  const written: ConfigFile[] = []
  try {
    for (const file of files) {
      const path = join(directory, file.relativePath)
      await mkdir(resolve(path, '..'), { recursive: true })
      await writeFile(path, file.content, { encoding: 'utf8', flag: 'wx' })
      const details = await stat(path)
      written.push({ id: relative(dshHome(), path).split(sep).join('/'), kind: request.kind, relativePath: relative(dshHome(), path).split(sep).join('/'), bytes: details.size, modifiedAt: details.mtimeMs, format: extensionOf(path) })
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return { files: written }
}

async function deleteConfig(request: ConfigDeleteRequest): Promise<ConfigDeleteValue> {
  const path = resolve(dshHome(), request.id)
  const root = managedRoot(request.kind)
  const relativePath = relativeInside(root, path)
  const parts = relativePath.split('/')
  const component = parts[0]
  let target: string
  if (parts.length === 1) {
    const details = await stat(path)
    if (!details.isFile() || !allowedFile(request.kind, path)) throw new Error('只能删除受支持的配置文件')
    target = path
  } else {
    if (component === undefined || !COMPONENT_NAME.test(component)) throw new Error('无法确定要删除的组件')
    target = join(root, component)
  }
  await rm(target, { recursive: true, force: false })
  return { deleted: [relative(dshHome(), target).split(sep).join('/')] }
}

function check(label: string, ok: boolean, detail: string): { label: string; ok: boolean; detail: string } {
  return { label, ok, detail }
}

function testContent(kind: ConfigKind, content: string, id = ''): ConfigTestValue {
  const checks: { label: string; ok: boolean; detail: string }[] = []
  checks.push(check('文件大小', content.length <= MAX_FILE_BYTES, content.length <= MAX_FILE_BYTES ? '在 512 KB 限制内' : '超过 512 KB'))
  if (kind === 'skills') {
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)
    checks.push(check('Skill frontmatter', frontmatter !== null, frontmatter === null ? '缺少 YAML frontmatter' : '已找到 frontmatter'))
    const metadata = frontmatter?.[1] ?? ''
    checks.push(check('Skill 字段', metadata.includes('name:') && metadata.includes('description:'), '需要 name 和 description'))
    checks.push(check('Skill 文件名', id === '' || id === 'SKILL.md' || id.endsWith('/SKILL.md'), '入口文件必须命名为 SKILL.md'))
  } else if (kind === 'mcp') {
    const hasTransport = /transport\s*:\s*(stdio|streamable-http)/.test(content) || /"transport"\s*:\s*"(stdio|streamable-http)"/.test(content)
    checks.push(check('MCP transport', hasTransport, hasTransport ? '已声明 stdio 或 streamable-http' : '缺少 transport'))
    checks.push(check('MCP serverName', /serverName\s*[:=]/.test(content) || /"serverName"\s*:/.test(content), '需要 serverName'))
    const usesHttp = /transport\s*:\s*streamable-http/.test(content) || /"transport"\s*:\s*"streamable-http"/.test(content)
    const target = usesHttp
      ? /(?:^|\n)\s*url\s*:/.test(content) || /"url"\s*:/.test(content)
      : /(?:^|\n)\s*command\s*:/.test(content) || /"command"\s*:/.test(content)
    checks.push(check('MCP 启动目标', target, usesHttp ? '远程服务需要 url' : '本地服务需要 command'))
    checks.push(check('Harness 接入', true, '静态测试不会执行命令；保存后仍需加入当前 Profile 才会注册工具'))
  } else {
    checks.push(check('Sub-agent preset', id === 'preset.yml' || id === 'agent.cordis.yml' || id.endsWith('/preset.yml') || id.endsWith('/agent.cordis.yml'), '已识别 Harness preset 文件'))
    checks.push(check('Sub-agent 内容', content.includes('name:') || content.includes('- id:'), '需要 preset 元数据或 Cordis 组合'))
  }
  return { ok: checks.every(item => item.ok), checks }
}

function generatedPrompt(kind: ConfigKind, prompt: string): string {
  const format = kind === 'skills'
    ? '返回一个文件：SKILL.md，包含合法 YAML frontmatter（name、description）和简洁的 Markdown 指令。'
    : kind === 'mcp'
      ? '返回一个 YAML 文件，使用 Harness 的 @deepseek-ai/dsh-mcp-client 配置，transport 必须是 stdio 或 streamable-http。'
      : '返回两个文件：preset.yml（name、description）和 agent.cordis.yml（合法 Cordis 数组）。'
  return `你是 DeepSeek Harness 配置设计助手。${format}\n只返回 JSON：{"summary":"一句话说明","files":[{"relativePath":"文件名","content":"文件内容"}]}。不要输出 Markdown 代码围栏，不要生成 API 密钥、Token 或真实凭据。用户需求：${prompt}`
}

function parseGenerated(text: string, kind: ConfigKind): ConfigGenerateValue {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed = JSON.parse(normalized) as { summary?: unknown; files?: unknown }
  if (!Array.isArray(parsed.files)) throw new Error('模型没有返回文件列表')
  const files = parsed.files.map(item => {
    if (item === null || typeof item !== 'object') throw new Error('模型返回了无效文件')
    const row = item as Record<string, unknown>
    if (typeof row.relativePath !== 'string' || typeof row.content !== 'string') throw new Error('模型返回了无效文件')
    return { relativePath: row.relativePath, content: row.content }
  })
  if (files.length === 0 || files.some(file => file.content.length > MAX_GENERATED_CHARS)) throw new Error('模型返回内容为空或过大')
  const checked = createFilesFor(kind, kind === 'skills' ? 'generated' : 'generated', files)
  return { summary: typeof parsed.summary === 'string' ? parsed.summary : '已生成配置草稿', files: checked }
}

async function generateConfig(runtime: ConfigRuntime, request: ConfigGenerateRequest): Promise<ConfigGenerateValue> {
  const prompt = stringOf(request.prompt)?.trim()
  if (prompt === undefined || prompt.length > MAX_PROMPT_CHARS) throw new Error('生成描述不能为空且不能超过 4000 字')
  if (runtime.llm === undefined || request.provider === undefined || request.model === undefined) throw new Error('当前 Harness 没有可用的模型路由，请先选择模型')
  const chunks: string[] = []
  let failure: string | undefined
  for await (const chunk of runtime.llm.stream({ provider: request.provider, model: request.model, messages: [{ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: generatedPrompt(request.kind, prompt) }], source: { kind: 'plugin', plugin: 'dsh-observatory' } }], maxTokens: 4_000 })) {
    const text = chunk.type === 'text-delta' && typeof chunk.text === 'string' ? chunk.text : ''
    if (text !== '') chunks.push(text)
    if (chunk.type === 'finish') {
      const reason = recordOf(chunk.reason)
      const kind = stringOf(reason.kind)
      if (kind !== undefined && kind !== 'stop') failure = stringOf(recordOf(reason.failure).message) ?? `模型生成以 ${kind} 结束`
    }
  }
  if (failure !== undefined) throw new Error(failure)
  if (chunks.length === 0) throw new Error('模型没有返回配置内容')
  return parseGenerated(chunks.join(''), request.kind)
}

async function testConfig(request: ConfigTestRequest): Promise<ConfigTestValue> {
  if (request.files !== undefined) {
    const results = request.files.map(file => testContent(request.kind, file.content, file.relativePath))
    return { ok: results.every(result => result.ok), checks: results.flatMap((result, index) => result.checks.map(item => ({ ...item, label: `${request.files?.[index]?.relativePath ?? '文件'} · ${item.label}` }))) }
  }
  if (request.content !== undefined) return testContent(request.kind, request.content, request.id ?? '')
  const id = stringOf(request.id)
  if (id === undefined) throw new Error('没有可测试的配置')
  const read = await readConfigFile(request.kind, id)
  return testContent(request.kind, read.content, id)
}

export async function handleConfigRpc(endpoint: string, payload: unknown, runtime: ConfigRuntime = {}): Promise<unknown> {
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
    if (endpoint === 'config/create') {
      const kind = kindOf(args.kind)
      const name = safeName(args.name)
      const files = Array.isArray(args.files) ? args.files.map(value => {
        const row = recordOf(value)
        const relativePath = stringOf(row.relativePath)
        const content = typeof row.content === 'string' ? row.content : undefined
        if (relativePath === undefined || content === undefined) throw new Error('无效的创建文件')
        return { relativePath, content }
      }) : undefined
      if (kind === undefined || files === undefined) throw new Error('无效的创建请求')
      return { ok: true, value: await createConfig({ kind, name, files }) }
    }
    if (endpoint === 'config/delete') {
      const kind = kindOf(args.kind)
      const id = stringOf(args.id)
      if (kind === undefined || id === undefined) throw new Error('无效的删除请求')
      return { ok: true, value: await deleteConfig({ kind, id }) }
    }
    if (endpoint === 'config/test') {
      const kind = kindOf(args.kind)
      if (kind === undefined) throw new Error('无效的测试请求')
      const files = Array.isArray(args.files) ? args.files.map(value => {
        const row = recordOf(value)
        const relativePath = stringOf(row.relativePath)
        const content = typeof row.content === 'string' ? row.content : undefined
        if (relativePath === undefined || content === undefined) throw new Error('无效的测试文件')
        return { relativePath, content }
      }) : undefined
      return { ok: true, value: await testConfig({ kind, ...(stringOf(args.id) === undefined ? {} : { id: stringOf(args.id) }), ...(typeof args.content === 'string' ? { content: args.content } : {}), ...(files === undefined ? {} : { files }) }) }
    }
    if (endpoint === 'config/generate') {
      const kind = kindOf(args.kind)
      const prompt = stringOf(args.prompt)
      if (kind === undefined || prompt === undefined) throw new Error('无效的生成请求')
      return { ok: true, value: await generateConfig(runtime, { kind, prompt, ...(stringOf(args.provider) === undefined ? {} : { provider: stringOf(args.provider) }), ...(stringOf(args.model) === undefined ? {} : { model: stringOf(args.model) }) }) }
    }
    return { ok: false, error: { code: 'not-found', message: '未知的 Observatory 配置接口' } }
  } catch (error) {
    return { ok: false, error: { code: 'config-rejected', message: error instanceof Error ? error.message : '配置操作失败' } }
  }
}

/** 在 Harness Host 上注册受限的 .dsh 配置通道。 */
export function installConfigRpc(ctx: { inject(keys: readonly string[], callback: (scope: { get(name: string): unknown }) => void): unknown }): void {
  ctx.inject(['connection', 'llm'], (scope) => {
    const connection = scope.get('connection') as HostConnection
    const llm = scope.get('llm') as HostLlm
    connection.rpc.handle('/observatory', (endpoint, payload) => handleConfigRpc(endpoint, payload, { llm }), { authority: 'trusted-host' })
  })
}
