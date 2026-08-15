export type EventCategory = 'turn' | 'model' | 'tool' | 'context' | 'system'

export type EventStatus = 'running' | 'success' | 'warning' | 'error' | 'neutral'

export interface TimelineEvent {
  readonly id: string
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly category: EventCategory
  readonly status: EventStatus
  readonly title: string
  readonly detail?: string
  readonly turn?: number
  readonly step?: number
  readonly durationMs?: number
  readonly payload?: unknown
}

export interface MetricValue {
  readonly label: string
  readonly value: string
  readonly hint: string
  readonly tone: 'default' | 'good' | 'warning' | 'danger'
}

export interface ToolMetric {
  readonly name: string
  readonly calls: number
  readonly failures: number
  readonly averageDurationMs?: number
  readonly lastDurationMs?: number
}

export interface ContextItem {
  readonly id: string
  readonly kind: 'prompt' | 'skill' | 'tool-schema'
  readonly name: string
  readonly source: string
  readonly estimatedTokens: number
  readonly active: boolean
  readonly detail?: string
}

export interface RuntimeNode {
  readonly id: string
  readonly name: string
  readonly kind: 'profile' | 'bundle' | 'plugin' | 'service' | 'slot'
  readonly provider?: string
  readonly status: 'active' | 'waiting' | 'failed'
  readonly children?: readonly RuntimeNode[]
}

export interface RequestSummary {
  readonly provider: string
  readonly model: string
  readonly contextWindow?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
}

export interface ObservatorySnapshot {
  readonly sessionId?: string
  readonly sessionTitle: string
  readonly workspace?: string
  readonly status: 'idle' | 'running' | 'attention' | 'error'
  readonly updatedAt: number
  readonly metrics: readonly MetricValue[]
  readonly timeline: readonly TimelineEvent[]
  readonly tools: readonly ToolMetric[]
  readonly context: readonly ContextItem[]
  readonly runtime: readonly RuntimeNode[]
  readonly request?: RequestSummary
}

export interface ObservatoryExport {
  readonly format: 'dsh-observatory/v1'
  readonly exportedAt: string
  readonly snapshot: ObservatorySnapshot
}

export interface RawSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly [key: string]: unknown
}
