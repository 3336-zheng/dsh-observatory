import type {
  ContextItem,
  EventCategory,
  EventStatus,
  MetricValue,
  ObservatoryExport,
  ObservatorySnapshot,
  RawSessionEvent,
  RequestSummary,
  RuntimeNode,
  TimelineEvent,
  ToolMetric,
} from './model.ts'
import { redactValue, type RedactionOptions } from './redaction.ts'

export interface ObservatoryCollectorOptions {
  readonly maxEventsPerSession?: number
  readonly now?: () => number
}

interface ToolStart {
  readonly name: string
  readonly time: number
}

interface SessionRecord {
  readonly events: TimelineEvent[]
  readonly runningTools: Map<string, ToolStart>
  readonly context: Map<string, ContextItem>
  request?: RequestSummary
  title?: string
  workspace?: string
}

const EVENT_TITLES: Readonly<Record<string, string>> = {
  'turn/start': 'Turn 开始',
  'turn/end': 'Turn 完成',
  'step/start': 'Step 开始',
  'step/end': 'Step 完成',
  'request/header': '请求上下文已组装',
  'request/context': '模型路由已更新',
  'assistant/chunk': '模型正在生成',
  'assistant/message': '模型响应完成',
  'tool/call': '工具开始执行',
  'tool/result': '工具执行完成',
  'user/message': '用户消息进入上下文',
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function tokenEstimate(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return Math.max(0, Math.ceil((text?.length ?? 0) / 4))
}

function categoryOf(type: string): EventCategory {
  if (type.startsWith('turn/') || type.startsWith('step/')) return 'turn'
  if (type.startsWith('tool/')) return 'tool'
  if (type.startsWith('request/') || type.startsWith('user/')) return 'context'
  if (type.startsWith('assistant/')) return 'model'
  return 'system'
}

function statusOf(type: string, data: Record<string, unknown>): EventStatus {
  if (type.endsWith('/start') || type === 'tool/call' || type === 'assistant/chunk') return 'running'
  if (type === 'tool/result') return data.error === undefined ? 'success' : 'error'
  if (type === 'turn/end') {
    const reason = asRecord(data.reason)
    if (reason.kind === 'error') return 'error'
    if (reason.kind === 'aborted' || reason.kind === 'blocked' || reason.kind === 'max-tokens') return 'warning'
    return 'success'
  }
  if (type.endsWith('/end') || type === 'assistant/message') return 'success'
  return 'neutral'
}

function callIdOf(data: Record<string, unknown>): string | undefined {
  const message = asRecord(data.message)
  return asString(data.callId)
    ?? asString(message.callId)
    ?? asString(message.toolCallId)
    ?? asString(message.tool_call_id)
}

function usageOf(data: Record<string, unknown>): { input?: number; output?: number } {
  const usage = asRecord(data.usage)
  return {
    input: asNumber(usage.inputTokens) ?? asNumber(usage.promptTokens) ?? asNumber(usage.input_tokens),
    output: asNumber(usage.outputTokens) ?? asNumber(usage.completionTokens) ?? asNumber(usage.output_tokens),
  }
}

function detailOf(type: string, data: Record<string, unknown>): string | undefined {
  if (type === 'tool/call') return asString(data.name)
  if (type === 'tool/result') {
    const error = asRecord(data.error)
    return asString(error.code) ?? asString(error.name)
  }
  if (type === 'request/context') {
    return [asString(data.provider), asString(data.model)].filter(Boolean).join(' / ')
  }
  if (type === 'turn/end') return asString(asRecord(data.reason).kind)
  if (type === 'assistant/message') {
    const usage = usageOf(data)
    if (usage.output !== undefined) return `${String(usage.output)} tokens`
  }
  return undefined
}

function titleOf(type: string, data: Record<string, unknown>, runningTools: Map<string, ToolStart>): string {
  if (type === 'tool/call') return `调用 ${asString(data.name) ?? '工具'}`
  if (type === 'tool/result') {
    const callId = callIdOf(data)
    const name = callId === undefined ? undefined : runningTools.get(callId)?.name
    return `${name ?? '工具'} 返回结果`
  }
  return EVENT_TITLES[type] ?? type
}

/**
 * 将 DSH 的持久化 Session Event 归一化为可查询、可导出的观测快照。
 */
export class ObservatoryCollector {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly maxEventsPerSession: number
  private readonly now: () => number

  constructor(options: ObservatoryCollectorOptions = {}) {
    this.maxEventsPerSession = Math.max(100, options.maxEventsPerSession ?? 2_000)
    this.now = options.now ?? Date.now
  }

  /**
   * 记录一条来自 Harness 的 Session Event。
   * @param sessionId 会话标识。
   * @param event DSH 原始事件。
   */
  record(sessionId: string, event: RawSessionEvent): void {
    const session = this.session(sessionId)
    const data = asRecord(event.data)
    const callId = callIdOf(data)
    let durationMs: number | undefined
    const title = titleOf(event.type, data, session.runningTools)

    if (event.type === 'tool/call' && callId !== undefined) {
      session.runningTools.set(callId, { name: asString(data.name) ?? 'unknown', time: event.time })
    } else if (event.type === 'tool/result' && callId !== undefined) {
      const started = session.runningTools.get(callId)
      if (started !== undefined) {
        durationMs = Math.max(0, event.time - started.time)
        session.runningTools.delete(callId)
      }
    }

    this.captureRequest(session, event.type, data)
    const normalized: TimelineEvent = {
      id: `${sessionId}:${String(event.seq)}`,
      seq: event.seq,
      time: event.time,
      type: event.type,
      category: categoryOf(event.type),
      status: statusOf(event.type, data),
      title,
      ...(detailOf(event.type, data) === undefined ? {} : { detail: detailOf(event.type, data) }),
      ...(asNumber(data.turn) === undefined ? {} : { turn: asNumber(data.turn) }),
      ...(asNumber(data.step) === undefined ? {} : { step: asNumber(data.step) }),
      ...(durationMs === undefined ? {} : { durationMs }),
      payload: event.data,
    }
    session.events.push(normalized)
    if (session.events.length > this.maxEventsPerSession) {
      session.events.splice(0, session.events.length - this.maxEventsPerSession)
    }
  }

  /**
   * 更新不属于事件日志的展示元数据。
   * @param sessionId 会话标识。
   * @param metadata 标题和工作区信息。
   */
  describe(sessionId: string, metadata: { title?: string; workspace?: string }): void {
    const session = this.session(sessionId)
    if (metadata.title !== undefined) session.title = metadata.title
    if (metadata.workspace !== undefined) session.workspace = metadata.workspace
  }

  /**
   * 读取一个会话的不可变观测快照。
   * @param sessionId 会话标识。
   * @param runtime 可选的运行时插件树。
   * @returns 面向 UI 和导出的归一化快照。
   */
  snapshot(sessionId: string, runtime: readonly RuntimeNode[] = []): ObservatorySnapshot {
    const session = this.session(sessionId)
    const timeline = session.events.map(event => ({ ...event }))
    const tools = this.toolMetrics(timeline)
    const usage = timeline.reduce((sum, event) => {
      if (event.type !== 'assistant/message') return sum
      const values = usageOf(asRecord(event.payload))
      return { input: sum.input + (values.input ?? 0), output: sum.output + (values.output ?? 0) }
    }, { input: 0, output: 0 })
    const turns = timeline.filter(event => event.type === 'turn/end').length
    const failures = timeline.filter(event => event.status === 'error').length
    const toolCalls = timeline.filter(event => event.type === 'tool/call').length
    const contextTokens = [...session.context.values()].reduce((sum, item) => sum + item.estimatedTokens, 0)
    const metrics: MetricValue[] = [
      { label: 'Turns', value: String(turns), hint: '已结束', tone: 'default' },
      { label: '工具调用', value: String(toolCalls), hint: `${String(tools.length)} 种工具`, tone: 'default' },
      { label: '输出 Token', value: usage.output.toLocaleString(), hint: `${usage.input.toLocaleString()} 输入`, tone: 'good' },
      { label: '上下文估算', value: contextTokens.toLocaleString(), hint: '约数', tone: contextTokens > 24_000 ? 'warning' : 'default' },
    ]
    const last = timeline.at(-1)
    const status = failures > 0 && last?.status === 'error'
      ? 'error'
      : session.runningTools.size > 0 || last?.status === 'running' ? 'running' : 'idle'
    return {
      sessionId,
      sessionTitle: session.title ?? `Session ${sessionId.slice(0, 8)}`,
      ...(session.workspace === undefined ? {} : { workspace: session.workspace }),
      status,
      updatedAt: last?.time ?? this.now(),
      metrics,
      timeline,
      tools,
      context: [...session.context.values()],
      runtime,
      ...(session.request === undefined ? {} : { request: { ...session.request } }),
    }
  }

  /**
   * 生成默认脱敏的可移植 JSON 导出对象。
   * @param sessionId 会话标识。
   * @param options 脱敏选项。
   * @returns 带格式版本和导出时间的对象。
   */
  export(sessionId: string, options?: RedactionOptions): ObservatoryExport {
    const payload: ObservatoryExport = {
      format: 'dsh-observatory/v1',
      exportedAt: new Date(this.now()).toISOString(),
      snapshot: this.snapshot(sessionId),
    }
    return redactValue(payload, options) as ObservatoryExport
  }

  /** 清空一个会话，未传入标识时清空全部会话。 */
  clear(sessionId?: string): void {
    if (sessionId === undefined) this.sessions.clear()
    else this.sessions.delete(sessionId)
  }

  private session(sessionId: string): SessionRecord {
    let record = this.sessions.get(sessionId)
    if (record === undefined) {
      record = { events: [], runningTools: new Map(), context: new Map() }
      this.sessions.set(sessionId, record)
    }
    return record
  }

  private captureRequest(session: SessionRecord, type: string, data: Record<string, unknown>): void {
    if (type === 'request/context') {
      session.request = {
        provider: asString(data.provider) ?? session.request?.provider ?? 'unknown',
        model: asString(data.model) ?? session.request?.model ?? 'unknown',
        ...(asNumber(data.contextWindow) === undefined ? {} : { contextWindow: asNumber(data.contextWindow) }),
      }
      return
    }
    if (type === 'assistant/message') {
      const usage = usageOf(data)
      session.request = {
        provider: session.request?.provider ?? 'unknown',
        model: session.request?.model ?? 'unknown',
        ...(session.request?.contextWindow === undefined ? {} : { contextWindow: session.request.contextWindow }),
        ...(usage.input === undefined ? {} : { inputTokens: usage.input }),
        ...(usage.output === undefined ? {} : { outputTokens: usage.output }),
      }
      return
    }
    if (type !== 'request/header') return
    const header = asRecord(data.header)
    const config = asRecord(header.config)
    const system = asString(header.system)
    if (system !== undefined) {
      session.context.set('system-prompt', {
        id: 'system-prompt',
        kind: 'prompt',
        name: 'System Prompt',
        source: 'request/header',
        estimatedTokens: tokenEstimate(system),
        active: true,
        detail: system,
      })
    }
    const tools = Array.isArray(header.tools) ? header.tools : []
    for (const [index, candidate] of tools.entries()) {
      const tool = asRecord(candidate)
      const name = asString(tool.name) ?? `tool-${String(index + 1)}`
      session.context.set(`tool:${name}`, {
        id: `tool:${name}`,
        kind: 'tool-schema',
        name,
        source: 'ctx.tools',
        estimatedTokens: tokenEstimate(tool),
        active: true,
        detail: asString(tool.description),
      })
    }
    session.request = {
      provider: asString(config.provider) ?? session.request?.provider ?? 'unknown',
      model: asString(config.model) ?? session.request?.model ?? 'unknown',
      ...(session.request?.contextWindow === undefined ? {} : { contextWindow: session.request.contextWindow }),
    }
  }

  private toolMetrics(events: readonly TimelineEvent[]): ToolMetric[] {
    const calls = new Map<string, { calls: number; failures: number; durations: number[] }>()
    const namesByCall = new Map<string, string>()
    for (const event of events) {
      const payload = asRecord(event.payload)
      const callId = callIdOf(payload)
      if (event.type === 'tool/call') {
        const name = asString(payload.name) ?? 'unknown'
        if (callId !== undefined) namesByCall.set(callId, name)
        const current = calls.get(name) ?? { calls: 0, failures: 0, durations: [] }
        current.calls += 1
        calls.set(name, current)
      }
      if (event.type === 'tool/result') {
        const name = callId === undefined ? undefined : namesByCall.get(callId)
        if (name === undefined) continue
        const current = calls.get(name)
        if (current === undefined) continue
        if (event.status === 'error') current.failures += 1
        if (event.durationMs !== undefined) current.durations.push(event.durationMs)
      }
    }
    return [...calls.entries()].map(([name, value]) => ({
      name,
      calls: value.calls,
      failures: value.failures,
      ...(value.durations.length === 0 ? {} : {
        averageDurationMs: Math.round(value.durations.reduce((sum, item) => sum + item, 0) / value.durations.length),
        lastDurationMs: value.durations.at(-1),
      }),
    })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
  }
}
