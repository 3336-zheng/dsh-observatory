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

  it('maps slot registry snapshots into runtime nodes', () => {
    const runtime = runtimeFromSlots([{
      name: 'root', kind: 'single', scope: 'root',
      occupants: [{ registrant: 'layout', active: true }],
      children: [{ name: 'sidebar', kind: 'single', scope: 'root', occupants: [] }],
    }])
    expect(runtime[0]).toMatchObject({ id: 'slot:root', name: 'root', kind: 'slot' })
    expect(runtime[0]?.children?.map(item => item.name)).toEqual(['layout', 'sidebar'])
  })
})
