import type {
  ContextItem,
  MetricValue,
  ObservatorySnapshot,
  RequestSummary,
  RuntimeNode,
  TimelineEvent,
  ToolMetric,
} from '../model.ts'

export interface ClientSessionInput {
  readonly sessionId?: string
  readonly title?: string
  readonly workspace?: string
  readonly value?: unknown
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function valuesOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value instanceof Map) return [...value.values()]
  if (value !== null && typeof value === 'object') return Object.values(value)
  return []
}

function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return Math.ceil((text?.length ?? 0) / 4)
}

function nodeType(kind: string): string {
  if (kind.includes('tool') && kind.includes('result')) return 'tool/result'
  if (kind.includes('tool')) return 'tool/call'
  if (kind.includes('assistant')) return 'assistant/message'
  if (kind.includes('user')) return 'user/message'
  if (kind.includes('error')) return 'turn/end'
  if (kind.includes('turn')) return `turn/${kind.includes('end') ? 'end' : 'start'}`
  return kind
}

function nodeTitle(type: string, node: Record<string, unknown>): string {
  if (type === 'tool/call') return `调用 ${stringOf(node.name) ?? stringOf(node.toolName) ?? '工具'}`
  if (type === 'tool/result') return `${stringOf(node.name) ?? stringOf(node.toolName) ?? '工具'} 返回结果`
  if (type === 'assistant/message') return '模型响应'
  if (type === 'user/message') return '用户消息'
  if (type === 'turn/end') return 'Turn 异常结束'
  return stringOf(node.title) ?? type
}

function detailOf(type: string, node: Record<string, unknown>): string | undefined {
  const content = stringOf(node.text) ?? stringOf(node.content) ?? stringOf(node.message)
  if (content !== undefined) return content.slice(0, 180)
  if (type.startsWith('tool/')) return stringOf(node.name) ?? stringOf(node.toolName)
  return stringOf(node.detail) ?? stringOf(node.reason)
}

function statusOf(type: string, node: Record<string, unknown>): TimelineEvent['status'] {
  if (node.error !== undefined || type === 'turn/end') return 'error'
  if (node.running === true || node.pending === true) return 'running'
  if (type === 'tool/result' || type === 'assistant/message') return 'success'
  return 'neutral'
}

function timelineOf(snapshot: Record<string, unknown>, now: number): TimelineEvent[] {
  const chat = recordOf(snapshot.chat)
  const source = valuesOf(chat.nodes).length > 0 ? valuesOf(chat.nodes) : valuesOf(snapshot.nodes)
  const rows = source.map((candidate, index): TimelineEvent => {
    const node = recordOf(candidate)
    const kind = stringOf(node.kind) ?? stringOf(node.type) ?? 'event'
    const type = nodeType(kind)
    const startedAt = numberOf(node.startedAt) ?? numberOf(node.time) ?? now + index
    const endedAt = numberOf(node.endedAt)
    const durationMs = numberOf(node.durationMs)
      ?? (endedAt === undefined ? undefined : Math.max(0, endedAt - startedAt))
    const status = statusOf(type, node)
    return {
      id: stringOf(node.id) ?? stringOf(node.key) ?? `node:${String(index)}`,
      seq: numberOf(node.seq) ?? index + 1,
      time: startedAt,
      type,
      category: type.startsWith('tool/')
        ? 'tool'
        : type.startsWith('assistant/') ? 'model' : type.startsWith('user/') ? 'context' : 'turn',
      status,
      title: nodeTitle(type, node),
      ...(detailOf(type, node) === undefined ? {} : { detail: detailOf(type, node) }),
      ...(numberOf(node.turn) === undefined ? {} : { turn: numberOf(node.turn) }),
      ...(numberOf(node.step) === undefined ? {} : { step: numberOf(node.step) }),
      ...(durationMs === undefined ? {} : { durationMs }),
      payload: node,
    }
  })

  const running = valuesOf(snapshot.runningCalls)
  for (const [index, candidate] of running.entries()) {
    const call = recordOf(candidate)
    const name = stringOf(call.name) ?? stringOf(call.toolName) ?? '工具'
    rows.push({
      id: stringOf(call.callId) ?? `running:${String(index)}`,
      seq: rows.length + index + 1,
      time: numberOf(call.startedAt) ?? now,
      type: 'tool/call',
      category: 'tool',
      status: 'running',
      title: `调用 ${name}`,
      detail: name,
      payload: call,
    })
  }
  return rows.sort((a, b) => a.seq - b.seq || a.time - b.time)
}

function contextOf(snapshot: Record<string, unknown>): ContextItem[] {
  const candidates = [
    recordOf(snapshot.request),
    recordOf(snapshot.requestInspection),
    ...valuesOf(snapshot.nodes).map(recordOf).reverse(),
  ]
  const context: ContextItem[] = []
  for (const candidate of candidates) {
    const header = Object.keys(recordOf(candidate.header)).length > 0 ? recordOf(candidate.header) : candidate
    const system = stringOf(header.system) ?? stringOf(header.systemPrompt)
    if (system !== undefined && !context.some(item => item.id === 'system-prompt')) {
      context.push({
        id: 'system-prompt',
        kind: 'prompt',
        name: 'System Prompt',
        source: 'request/header',
        estimatedTokens: estimateTokens(system),
        active: true,
        detail: system,
      })
    }
    const tools = valuesOf(header.tools)
    for (const [index, rawTool] of tools.entries()) {
      const tool = recordOf(rawTool)
      const name = stringOf(tool.name) ?? `tool-${String(index + 1)}`
      if (context.some(item => item.id === `tool:${name}`)) continue
      context.push({
        id: `tool:${name}`,
        kind: 'tool-schema',
        name,
        source: 'ctx.tools',
        estimatedTokens: estimateTokens(tool),
        active: true,
        detail: stringOf(tool.description),
      })
    }
  }
  return context
}

function toolsOf(events: readonly TimelineEvent[]): ToolMetric[] {
  const rows = new Map<string, { calls: number; failures: number; durations: number[] }>()
  for (const event of events) {
    if (!event.type.startsWith('tool/')) continue
    const payload = recordOf(event.payload)
    const name = stringOf(payload.name) ?? stringOf(payload.toolName) ?? event.detail ?? 'unknown'
    const row = rows.get(name) ?? { calls: 0, failures: 0, durations: [] }
    if (event.type === 'tool/call') row.calls += 1
    if (event.status === 'error') row.failures += 1
    if (event.durationMs !== undefined) row.durations.push(event.durationMs)
    rows.set(name, row)
  }
  return [...rows.entries()].map(([name, row]) => ({
    name,
    calls: row.calls,
    failures: row.failures,
    ...(row.durations.length === 0 ? {} : {
      averageDurationMs: Math.round(row.durations.reduce((sum, value) => sum + value, 0) / row.durations.length),
      lastDurationMs: row.durations.at(-1),
    }),
  }))
}

function requestOf(snapshot: Record<string, unknown>): RequestSummary | undefined {
  const request = recordOf(snapshot.request)
  const config = recordOf(request.config)
  const provider = stringOf(config.provider) ?? stringOf(request.provider)
  const model = stringOf(config.model) ?? stringOf(request.model)
  if (provider === undefined && model === undefined) return undefined
  return {
    provider: provider ?? 'unknown',
    model: model ?? 'unknown',
    ...(numberOf(request.contextWindow) === undefined ? {} : { contextWindow: numberOf(request.contextWindow) }),
    ...(numberOf(request.inputTokens) === undefined ? {} : { inputTokens: numberOf(request.inputTokens) }),
    ...(numberOf(request.outputTokens) === undefined ? {} : { outputTokens: numberOf(request.outputTokens) }),
  }
}

/** 将 DSH Client ConversationSnapshot 投影为 Observatory 视图模型。 */
export function deriveClientSnapshot(
  input: ClientSessionInput,
  runtime: readonly RuntimeNode[],
  now = Date.now(),
): ObservatorySnapshot {
  const snapshot = recordOf(input.value)
  const timeline = timelineOf(snapshot, now)
  const context = contextOf(snapshot)
  const tools = toolsOf(timeline)
  const errors = timeline.filter(event => event.status === 'error').length
  const turns = timeline.filter(event => event.type === 'turn/end').length
  const running = snapshot.running === true || timeline.some(event => event.status === 'running')
  const contextTokens = context.reduce((sum, item) => sum + item.estimatedTokens, 0)
  const metrics: MetricValue[] = [
    { label: 'Turns', value: String(turns), hint: '当前窗口', tone: 'default' },
    { label: '工具调用', value: String(timeline.filter(event => event.type === 'tool/call').length), hint: `${String(tools.length)} 种工具`, tone: 'default' },
    { label: '异常', value: String(errors), hint: errors === 0 ? '运行正常' : '需要检查', tone: errors === 0 ? 'good' : 'danger' },
    { label: '上下文估算', value: contextTokens.toLocaleString(), hint: 'tokens', tone: contextTokens > 24_000 ? 'warning' : 'default' },
  ]
  return {
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    sessionTitle: input.title ?? (input.sessionId === undefined ? '未选择会话' : `Session ${input.sessionId.slice(0, 8)}`),
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    status: errors > 0 && timeline.at(-1)?.status === 'error' ? 'error' : running ? 'running' : 'idle',
    updatedAt: timeline.at(-1)?.time ?? now,
    metrics,
    timeline,
    tools,
    context,
    runtime,
    ...(requestOf(snapshot) === undefined ? {} : { request: requestOf(snapshot) }),
  }
}

/** 将 DSH SlotRegistry 的动态快照压缩为运行时树。 */
export function runtimeFromSlots(value: unknown): RuntimeNode[] {
  const visit = (candidate: unknown, depth: number): RuntimeNode => {
    const row = recordOf(candidate)
    const name = stringOf(row.name) ?? `slot-${String(depth)}`
    const occupants = valuesOf(row.occupants)
    const children = valuesOf(row.children).map(child => visit(child, depth + 1))
    const occupantChildren = occupants.map((occupant, index): RuntimeNode => {
      const entry = recordOf(occupant)
      return {
        id: `${name}:occupant:${String(index)}`,
        name: stringOf(entry.registrant) ?? stringOf(entry.id) ?? stringOf(entry.key) ?? 'anonymous',
        kind: 'plugin',
        status: entry.active === false ? 'waiting' : 'active',
      }
    })
    return {
      id: `slot:${name}`,
      name,
      kind: 'slot',
      provider: stringOf(row.declaredBy),
      status: 'active',
      ...children.length + occupantChildren.length === 0 ? {} : { children: [...occupantChildren, ...children] },
    }
  }
  return valuesOf(value).map(item => visit(item, 0))
}
