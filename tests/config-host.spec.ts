import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listConfigFiles, readConfigFile, writeConfigFile } from '../src/config-host.ts'

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
})

