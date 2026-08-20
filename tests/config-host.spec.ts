import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleConfigRpc, listConfigFiles, readConfigFile, writeConfigFile } from '../src/config-host.ts'

describe('local .dsh config host', () => {
  let home = ''
  const previous = process.env.DSH_HOME

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-observatory-'))
    process.env.DSH_HOME = home
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })

  it('lists only supported files inside the selected .dsh directory', async () => {
    await mkdir(join(home, 'skills', 'review'), { recursive: true })
    await writeFile(join(home, 'skills', 'review', 'SKILL.md'), '# Review')
    await writeFile(join(home, 'skills', 'review', 'notes.txt'), 'ignore')
    await writeFile(join(home, 'settings.yaml'), 'private: true')

    const result = await listConfigFiles('skills')
    expect(result.files.map(file => file.relativePath)).toEqual(['skills/review/SKILL.md'])
  })

  it('redacts MCP secrets while preserving them when saving unchanged redactions', async () => {
    await mkdir(join(home, 'mcp'), { recursive: true })
    await writeFile(join(home, 'mcp', 'servers.yaml'), 'apiKey: original-secret\ncommand: node server.js\n')
    const listed = await listConfigFiles('mcp')
    const file = listed.files[0]
    expect(file).toBeDefined()

    const read = await readConfigFile('mcp', file!.id)
    expect(read.content).toContain('apiKey: <redacted>')
    await writeConfigFile({ kind: 'mcp', id: file!.id, content: `${read.content}name: local\n`, expectedModifiedAt: file!.modifiedAt })
    expect(await readFile(join(home, 'mcp', 'servers.yaml'), 'utf8')).toContain('apiKey: original-secret')
  })

  it('rejects path traversal and stale writes', async () => {
    await mkdir(join(home, 'skills'), { recursive: true })
    await writeFile(join(home, 'skills', 'SKILL.md'), '# Initial')
    const file = (await listConfigFiles('skills')).files[0]!
    await expect(readConfigFile('skills', 'skills/../settings.yaml')).rejects.toThrow()
    await expect(writeConfigFile({ kind: 'skills', id: file.id, content: '# Changed', expectedModifiedAt: file.modifiedAt - 10 })).rejects.toThrow(/其他程序修改/)
  })

  it('creates, tests, and deletes a managed Skill component', async () => {
    const created = await handleConfigRpc('config/create', { args: {
      kind: 'skills', name: 'api-review', files: [{ relativePath: 'SKILL.md', content: '---\nname: api-review\ndescription: Review APIs.\n---\n\nReview input validation.\n' }],
    } })
    expect(created).toMatchObject({ ok: true, value: { files: [{ relativePath: 'skills/api-review/SKILL.md' }] } })
    const tested = await handleConfigRpc('config/test', { args: { kind: 'skills', id: 'skills/api-review/SKILL.md' } })
    expect(tested).toMatchObject({ ok: true, value: { ok: true } })
    const deleted = await handleConfigRpc('config/delete', { args: { kind: 'skills', id: 'skills/api-review/SKILL.md' } })
    expect(deleted).toMatchObject({ ok: true, value: { deleted: ['skills/api-review'] } })
    expect((await listConfigFiles('skills')).files).toHaveLength(0)
  })

  it('tests MCP and Sub-agent drafts without executing commands', async () => {
    const mcp = await handleConfigRpc('config/test', { args: { kind: 'mcp', files: [{ relativePath: 'server.yml', content: 'transport: stdio\nserverName: local\ncommand: rm\n' }] } })
    expect(mcp).toMatchObject({ ok: true, value: { ok: true } })
    const agent = await handleConfigRpc('config/test', { args: { kind: 'agents', files: [{ relativePath: 'preset.yml', content: 'name: Tester\ndescription: Test\n' }, { relativePath: 'agent.cordis.yml', content: '- id: persona\n' }] } })
    expect(agent).toMatchObject({ ok: true, value: { ok: true } })
  })

  it('rejects duplicate names and deletion outside managed roots', async () => {
    const request = { args: { kind: 'skills', name: 'same-name', files: [{ relativePath: 'SKILL.md', content: '---\nname: same-name\ndescription: Test.\n---\n' }] } }
    expect(await handleConfigRpc('config/create', request)).toMatchObject({ ok: true })
    expect(await handleConfigRpc('config/create', request)).toMatchObject({ ok: false, error: { message: '同名组件已存在' } })
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'cordis.yml'), '[]\n')
    expect(await handleConfigRpc('config/delete', { args: { kind: 'mcp', id: 'profiles/web/cordis.yml' } })).toMatchObject({ ok: false })
  })

  it('generates a preview through the selected Harness model without writing it', async () => {
    const llm = { async *stream() {
      yield { type: 'text-delta', text: '```json\n{"summary":"Generated","files":[{"relativePath":"SKILL.md","content":"---\\nname: generated\\ndescription: Generated skill.\\n---\\n"}]}\n```' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    const result = await handleConfigRpc('config/generate', { args: { kind: 'skills', prompt: 'Create a generated skill', provider: 'test', model: 'test' } }, { llm })
    expect(result).toMatchObject({ ok: true, value: { summary: 'Generated', files: [{ relativePath: 'SKILL.md' }] } })
    expect((await listConfigFiles('skills')).files).toHaveLength(0)
  })
})
