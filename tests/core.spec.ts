import { describe, expect, it } from 'vitest'
import { ObservatoryCollector } from '../src/core.ts'
import type { RawSessionEvent } from '../src/model.ts'

function event(type: string, seq: number, time: number, data: unknown): RawSessionEvent {
  return { type, seq, time, data }
}

describe('ObservatoryCollector', () => {
  it('derives tool duration, usage, context, and request metadata', () => {
    const collector = new ObservatoryCollector({ now: () => 10_000 })
    collector.record('s1', event('request/context', 1, 1_000, {
      provider: 'deepseek-official', model: 'deepseek-v4', contextWindow: 64_000,
    }))
    collector.record('s1', event('request/header', 2, 1_010, {
      header: {
        config: { provider: 'deepseek-official', model: 'deepseek-v4' },
        system: 'You are an agent.',
        tools: [{ name: 'bash', description: 'Run a command.' }],
      },
    }))
    collector.record('s1', event('tool/call', 3, 1_100, { callId: 'c1', name: 'bash' }))
    collector.record('s1', event('tool/result', 4, 1_460, { message: { toolCallId: 'c1' } }))
    collector.record('s1', event('assistant/message', 5, 1_500, {
      usage: { inputTokens: 240, outputTokens: 80 }, message: { content: 'done' },
    }))

    const snapshot = collector.snapshot('s1')
    expect(snapshot.request).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4' })
    expect(snapshot.context.map(item => item.id)).toEqual(['system-prompt', 'tool:bash'])
    expect(snapshot.tools).toEqual([{ name: 'bash', calls: 1, failures: 0, averageDurationMs: 360, lastDurationMs: 360 }])
    expect(snapshot.timeline.find(item => item.type === 'tool/result')?.durationMs).toBe(360)
    expect(snapshot.metrics.find(item => item.label === '输出 Token')?.value).toBe('80')
  })

  it('bounds retained events per session', () => {
    const collector = new ObservatoryCollector({ maxEventsPerSession: 100 })
    for (let index = 1; index <= 120; index += 1) {
      collector.record('s1', event('step/start', index, index, { step: index }))
    }
    const snapshot = collector.snapshot('s1')
    expect(snapshot.timeline).toHaveLength(100)
    expect(snapshot.timeline[0]?.seq).toBe(21)
  })

  it('exports a versioned, redacted payload', () => {
    const collector = new ObservatoryCollector({ now: () => 0 })
    collector.record('s1', event('tool/call', 1, 0, {
      callId: 'c1', name: 'bash', arguments: { token: 'secret-value' },
    }))
    expect(collector.export('s1')).toMatchObject({
      format: 'dsh-observatory/v1',
      exportedAt: '1970-01-01T00:00:00.000Z',
      snapshot: { timeline: [{ payload: { arguments: { token: '[REDACTED]' } } }] },
    })
  })
})
