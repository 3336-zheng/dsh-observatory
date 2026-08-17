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

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (Array.isArray(value)) {
    const text = value.map(textOf).filter((item): item is string => item !== undefined).join(' ')
    return text.length > 0 ? text : undefined
  }
  if (value !== null && typeof value === 'object') {
    const item = recordOf(value)
    return stringOf(item.text)
      ?? stringOf(item.content)
      ?? textOf(item.blocks)
      ?? textOf(item.message)
  }
  return undefined
}

function previewOf(value: unknown, limit = 15): string | undefined {
  const text = textOf(value)
  if (text === undefined) return undefined
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length === 0) return undefined
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}

function valuesOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value instanceof Map) return [...value.values()]
  if (value !== null && typeof value === 'object') return Object.values(value)
  return []
}

function entriesOf(value: unknown): Array<[unknown, unknown]> {
  if (value instanceof Map) return [...value.entries()]
  if (value !== null && typeof value === 'object') return Object.entries(value)
  return []
}

function viewOf(snapshot: Record<string, unknown>, key: string): Record<string, unknown> {
  const views = recordOf(snapshot.views)
  const get = views.get
  if (typeof get !== 'function') return {}
  try {
    return recordOf((get as (name: string) => unknown).call(snapshot.views, key))
  } catch {
    return {}
  }
}

function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return Math.ceil((text?.length ?? 0) / 4)
}

function nodeType(kind: string): string {
  const normalized = kind.toLowerCase()
  if (normalized === 'tool-result' || (normalized.includes('tool') && normalized.includes('result'))) return 'tool/result'
  if (normalized === 'tool-call' || normalized.includes('tool')) return 'tool/call'
  if (normalized === 'assistant' || normalized.includes('assistant')) return 'assistant/message'
  if (normalized === 'user' || normalized === 'steering' || normalized.includes('user')) return 'user/message'
  if (normalized === 'context') return 'context/message'
  if (normalized === 'model-retry') return 'model/retry'
  if (normalized === 'command') return 'system/command'
  if (normalized === 'compaction') return 'context/compaction'
  if (normalized.includes('error')) return 'turn/end'
  if (normalized.includes('turn')) return `turn/${normalized.includes('end') ? 'end' : 'start'}`
  return kind
}

function nodeTitle(type: string, node: Record<string, unknown>): string {
  const call = recordOf(node.call)
  const toolName = stringOf(node.name) ?? stringOf(node.toolName) ?? stringOf(call.name) ?? '工具'
  if (type === 'tool/call') return `调用 ${toolName}`
  if (type === 'tool/result') return `${toolName} 返回结果`
  if (type === 'assistant/message') return previewOf(node.blocks ?? node.content ?? node.message) ?? '模型响应'
  if (type === 'user/message') return previewOf(node.content ?? node.text ?? node.message) ?? '用户消息'
  if (type === 'context/message') return '上下文注入'
  if (type === 'context/compaction') return '上下文压缩'
  if (type === 'model/retry') return '模型重试'
  if (type === 'system/command') return stringOf(node.name) ?? '系统命令'
  if (type === 'turn/end') return 'Turn 异常结束'
  return stringOf(node.title) ?? type
}

function detailOf(type: string, node: Record<string, unknown>): string | undefined {
  const content = stringOf(node.text)
    ?? textOf(node.content)
    ?? textOf(node.blocks)
    ?? stringOf(node.message)
  if (content !== undefined) return content.slice(0, 180)
  if (type.startsWith('tool/')) {
    const call = recordOf(node.call)
    return stringOf(node.name) ?? stringOf(node.toolName) ?? stringOf(call.name)
  }
  const reason = recordOf(node.reason)
  return stringOf(node.detail)
    ?? stringOf(node.message)
    ?? stringOf(reason.kind)
}

function statusOf(type: string, node: Record<string, unknown>): TimelineEvent['status'] {
  if (node.error !== undefined || node.isError === true || (type === 'turn/end' && node.kind === 'turn-error')) return 'error'
  if (node.running === true || node.pending === true) return 'running'
  if (type === 'tool/result' || type === 'assistant/message' || type === 'user/message') return 'success'
  if (type === 'turn/end' || type === 'model/retry') return 'warning'
  return 'neutral'
}

function timelineOf(snapshot: Record<string, unknown>, now: number): TimelineEvent[] {
  const chat = recordOf(snapshot.chat)
  // Harness 的 chat.nodes 是面向渲染的视图节点，兼容字段集中在 snapshot.nodes。
  const legacyNodes = valuesOf(snapshot.nodes)
  const chatNodes = valuesOf(chat.nodes)
  const source = legacyNodes.length > 0 ? legacyNodes : chatNodes
  const rows: TimelineEvent[] = []
  source.forEach((candidate, index) => {
    const node = recordOf(candidate)
    const kind = stringOf(node.kind) ?? stringOf(node.type) ?? 'event'
    const type = nodeType(kind)
    const startedAt = numberOf(node.startedAt) ?? numberOf(node.time) ?? now + index
    const endedAt = numberOf(node.endedAt)
    const durationMs = numberOf(node.durationMs)
      ?? (endedAt === undefined ? undefined : Math.max(0, endedAt - startedAt))
    const status = statusOf(type, node)
    const base: TimelineEvent = {
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
    if (type === 'tool/result') {
      const call = recordOf(node.call)
      const callTime = numberOf(node.callTime)
      const callName = stringOf(call.name) ?? stringOf(node.name) ?? stringOf(node.toolName)
      if (callTime !== undefined) {
        rows.push({
          ...base,
          id: `${base.id}:call`,
          seq: base.seq - 0.1,
          time: callTime,
          type: 'tool/call',
          status: 'success',
          title: `调用 ${callName ?? '工具'}`,
          ...(callName === undefined ? {} : { detail: callName }),
          ...(stringOf(call.argsRaw) === undefined ? {} : { payload: { ...node, arguments: call.argsRaw } }),
        })
      }
      rows.push({ ...base, ...(callName === undefined ? {} : { title: `${callName} 返回结果` }) })
      return
    }
    rows.push(base)

    // Assistant blocks retain model-requested tool calls even when the paired result is later.
    for (const [blockIndex, block] of valuesOf(node.blocks).entries()) {
      const blockRow = recordOf(block)
      if (stringOf(blockRow.kind) !== 'tool-call') continue
      const callName = stringOf(blockRow.name) ?? '工具'
      rows.push({
        id: `${base.id}:tool:${String(blockIndex)}`,
        seq: base.seq + (blockIndex + 1) / 100,
        time: startedAt,
        type: 'tool/call',
        category: 'tool',
        status: 'success',
        title: `调用 ${callName}`,
        detail: callName,
        ...(numberOf(node.turn) === undefined ? {} : { turn: numberOf(node.turn) }),
        ...(numberOf(node.step) === undefined ? {} : { step: numberOf(node.step) }),
        payload: block,
      })
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
  const turnRanges = entriesOf(snapshot.turnTimings).flatMap(([rawTurn, rawTiming]) => {
    const turn = numberOf(rawTurn)
    const timing = recordOf(rawTiming)
    const start = numberOf(timing.startTime)
    if (turn === undefined || start === undefined) return []
    return [{ turn, start, end: numberOf(timing.endTime) }]
  })
  return rows
    .map(event => {
      if (event.turn !== undefined) return event
      const range = turnRanges.find(candidate => event.time >= candidate.start && (candidate.end === undefined || event.time <= candidate.end))
      return range === undefined ? event : { ...event, turn: range.turn }
    })
    .sort((a, b) => a.seq - b.seq || a.time - b.time)
}

function contextOf(snapshot: Record<string, unknown>): ContextItem[] {
  const trajectory = viewOf(snapshot, 'trajectory')
  const requests = valuesOf(trajectory.requests).reverse()
  const candidates = [
    recordOf(snapshot.request),
    recordOf(snapshot.requestInspection),
    ...requests.map(request => recordOf(recordOf(request).prompt)),
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

    if (candidate.kind === 'context') {
      const provenance = recordOf(candidate.provenance)
      const source = stringOf(provenance.label) ?? stringOf(candidate.source) ?? 'Harness context'
      const detail = textOf(candidate.content)
      const id = `context:${stringOf(candidate.seq) ?? String(context.length)}`
      if (!context.some(item => item.id === id)) {
        context.push({
          id,
          kind: stringOf(provenance.label)?.includes('skill') ? 'skill' : 'prompt',
          name: source,
          source: source,
          estimatedTokens: estimateTokens(detail ?? candidate.content),
          active: true,
          ...(detail === undefined ? {} : { detail }),
        })
      }
    }
  }

  // Trajectory keeps schemas keyed by tool call id; include them even when a
  // request's complete tool catalog is unavailable in a paged session.
  for (const [index, rawTool] of valuesOf(trajectory.callSchemas).entries()) {
    const tool = recordOf(rawTool)
    const name = stringOf(tool.name) ?? `tool-${String(index + 1)}`
    if (context.some(item => item.id === `tool:${name}`)) continue
    context.push({
      id: `tool:${name}`,
      kind: 'tool-schema',
      name,
      source: 'trajectory.callSchemas',
      estimatedTokens: estimateTokens(tool),
      active: true,
      detail: stringOf(tool.description),
    })
  }
  return context
}

function toolsOf(events: readonly TimelineEvent[]): ToolMetric[] {
  const rows = new Map<string, { calls: number; failures: number; durations: number[] }>()

  // 只从调用事件建立工具名称索引。结果事件的 detail 通常是命令输出，不能当作工具名。
  const callNames = new Map<string, string>()
  const callEvents = new Map<string, TimelineEvent>()
  const callIds = new Set<string>()
  const nameOfCall = (event: TimelineEvent): string | undefined => {
    const payload = recordOf(event.payload)
    const call = recordOf(payload.call)
    return stringOf(payload.name)
      ?? stringOf(payload.toolName)
      ?? stringOf(call.name)
      ?? (event.type === 'tool/call' ? event.detail : undefined)
  }

  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const payload = recordOf(event.payload)
    const name = nameOfCall(event)
    if (name === undefined) continue
    const call = recordOf(payload.call)
    const callId = stringOf(payload.callId)
      ?? stringOf(payload.id)
      ?? stringOf(call.callId)
      ?? event.id
    callNames.set(callId, name)
    callEvents.set(callId, event)
    if (callIds.has(callId)) continue
    callIds.add(callId)
    const row = rows.get(name) ?? { calls: 0, failures: 0, durations: [] }
    row.calls += 1
    rows.set(name, row)
  }

  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const payload = recordOf(event.payload)
    const call = recordOf(payload.call)
    const callId = stringOf(payload.callId)
      ?? stringOf(payload.id)
      ?? stringOf(call.callId)
    const name = stringOf(payload.name)
      ?? stringOf(payload.toolName)
      ?? stringOf(call.name)
      ?? (callId === undefined ? undefined : callNames.get(callId))
    if (name === undefined) continue
    const row = rows.get(name) ?? { calls: 0, failures: 0, durations: [] }
    if (event.status === 'error') row.failures += 1
    if (event.durationMs !== undefined) row.durations.push(event.durationMs)
    rows.set(name, row)
    if (callId !== undefined) callEvents.delete(callId)
  }

  // 尚未返回的调用仍可提供耗时（例如运行中的工具）。
  for (const event of callEvents.values()) {
    const name = nameOfCall(event)
    if (name === undefined || event.durationMs === undefined) continue
    const row = rows.get(name)
    if (row !== undefined) row.durations.push(event.durationMs)
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
  const trajectory = viewOf(snapshot, 'trajectory')
  const requests = valuesOf(trajectory.requests)
  const latest = recordOf(requests.at(-1))
  const request = Object.keys(recordOf(snapshot.request)).length > 0
    ? recordOf(snapshot.request)
    : latest
  const config = recordOf(request.config)
  const requestConfig = recordOf(request.requestConfig)
  const prompt = recordOf(request.prompt)
  const promptConfig = recordOf(prompt.config)
  const provider = stringOf(config.provider)
    ?? stringOf(request.provider)
    ?? stringOf(requestConfig.provider)
    ?? stringOf(promptConfig.provider)
  const model = stringOf(config.model)
    ?? stringOf(request.model)
    ?? stringOf(requestConfig.model)
    ?? stringOf(promptConfig.model)
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
