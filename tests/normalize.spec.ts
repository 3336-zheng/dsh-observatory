import { describe, expect, it } from 'vitest'
import { deriveClientSnapshot, runtimeFromSlots } from '../src/client/normalize.ts'

describe('client normalization', () => {
  it('projects a generic DSH conversation snapshot', () => {
    const snapshot = deriveClientSnapshot({
      sessionId: 'session-1',
      title: 'Example',
      value: {
        running: false,
        request: { provider: 'deepseek', model: 'v4', system: 'System text', tools: [{ name: 'bash' }] },
        nodes: [
          { id: 'u1', kind: 'user-message', seq: 1, content: 'Check tests' },
          { id: 't1', kind: 'tool-call', seq: 2, name: 'bash', durationMs: 120 },
          { id: 'a1', kind: 'assistant-message', seq: 3, content: 'Done' },
        ],
      },
    }, [], 100)
    expect(snapshot.sessionTitle).toBe('Example')
    expect(snapshot.timeline.map(item => item.type)).toEqual(['user/message', 'tool/call', 'assistant/message'])
    expect(snapshot.tools[0]).toMatchObject({ name: 'bash', calls: 1 })
    expect(snapshot.context.map(item => item.id)).toEqual(['system-prompt', 'tool:bash'])
  })

  it('projects Harness legacy conversation nodes with readable details', () => {
    const snapshot = deriveClientSnapshot({
      sessionId: 'session-2',
      value: {
        nodes: [
          { kind: 'user', seq: 1, time: 100, content: [{ type: 'text', text: '检查当前项目结构以及测试和配置文件' }] },
          { kind: 'assistant', seq: 2, time: 200, turn: 1, step: 1, blocks: [{ kind: 'text', text: '我来检查项目结构、测试结果和配置文件是否正确' }] },
          {
            kind: 'tool-result', seq: 3, time: 400, turn: 1, step: 1, callId: 'call-1',
            call: { name: 'bash', argsRaw: '{"command":"pwd"}' }, callTime: 250, content: [], isError: false,
          },
        ],
      },
    }, [], 500)

    expect(snapshot.timeline.map(item => item.type)).toEqual([
      'user/message', 'assistant/message', 'tool/call', 'tool/result',
    ])
    expect(snapshot.timeline.map(item => item.title)).toEqual([
      '检查当前项目结构以及测试和配置...', '我来检查项目结构、测试结果和配...', '调用 bash', 'bash 返回结果',
    ])
    expect(snapshot.timeline[0]?.detail).toBe('检查当前项目结构以及测试和配置文件')
    expect(snapshot.timeline[1]?.detail).toBe('我来检查项目结构、测试结果和配置文件是否正确')
  })

  it('reads context and model identity from the Harness trajectory view', () => {
    const trajectory = {
      requests: [{
        purpose: 'assistant',
        requestConfig: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        prompt: {
          config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
          system: 'You are a coding agent.',
          tools: [{ name: 'bash', description: 'Run a shell command.' }],
        },
      }],
      callSchemas: new Map([['call-1', { name: 'apply_patch', description: 'Apply a patch.' }]]),
    }
    const snapshot = deriveClientSnapshot({
      sessionId: 'session-3',
      value: {
        views: { get: (key: string) => key === 'trajectory' ? trajectory : undefined },
      },
    }, [], 500)

    expect(snapshot.request).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(snapshot.context.map(item => item.name)).toEqual(['System Prompt', 'bash', 'apply_patch'])
  })

  it('maps slot registry snapshots into runtime nodes', () => {
    const runtime = runtimeFromSlots([{
      name: 'root', kind: 'single', scope: 'root',
      occupants: [{ registrant: 'layout', active: true }],
      children: [{ name: 'sidebar', kind: 'single', scope: 'root', occupants: [] }],
    }])
    expect(runtime[0]).toMatchObject({ id: 'slot:root', name: 'root', kind: 'slot' })
    expect(runtime[0]?.children?.map(item => item.name)).toEqual(['layout', 'sidebar'])
  })

  it('does not treat tool output as a tool name', () => {
    const snapshot = deriveClientSnapshot({
      sessionId: 'session-4',
      value: {
        nodes: [
          { kind: 'tool-call', id: 'call-1', seq: 1, name: 'bash' },
          {
            kind: 'tool-result', id: 'result-1', seq: 2, callId: 'call-1',
            content: '/Users/evose/projects/deepseek-harness\ntotal 24 drwxr-xr-x',
            durationMs: 42,
          },
        ],
      },
    }, [], 500)

    expect(snapshot.tools).toHaveLength(1)
    expect(snapshot.tools[0]).toMatchObject({ name: 'bash', calls: 1, averageDurationMs: 42, lastDurationMs: 42 })
  })
})
