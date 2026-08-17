import { Service, type Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { ObservatoryCollector, type ObservatoryCollectorOptions } from './core.ts'
import { installConfigRpc } from './config-host.ts'
import type { ObservatoryExport, ObservatorySnapshot, RawSessionEvent, RuntimeNode } from './model.ts'
import type { RedactionOptions } from './redaction.ts'

export type {
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
export { ObservatoryCollector } from './core.ts'
export { redactValue } from './redaction.ts'
export type { ObservatoryCollectorOptions } from './core.ts'
export type { RedactionOptions } from './redaction.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    observatory: ObservatoryService
  }
  interface Events {
    /** DSH 会话追加事件。 */
    'session/event'(session: { readonly id?: string; readonly sessionId?: string }, event: SessionEvent): void
  }
}

function sessionIdOf(session: unknown): string {
  if (session !== null && typeof session === 'object') {
    const candidate = session as { id?: unknown; sessionId?: unknown }
    if (typeof candidate.id === 'string') return candidate.id
    if (typeof candidate.sessionId === 'string') return candidate.sessionId
  }
  return 'unknown'
}

/** DSH Host 端观测服务。 */
export default class ObservatoryService extends Service {
  private readonly collector: ObservatoryCollector

  constructor(ctx: Context, options: ObservatoryCollectorOptions = {}) {
    super(ctx, 'observatory')
    this.collector = new ObservatoryCollector(options)
    installConfigRpc(ctx)
    ctx.on('session/event', (session, event) => {
      this.collector.record(sessionIdOf(session), event as SessionEvent as RawSessionEvent)
    })
  }

  /** 返回某个会话的观测快照。 */
  snapshot(sessionId: string, runtime?: readonly RuntimeNode[]): ObservatorySnapshot {
    return this.collector.snapshot(sessionId, runtime)
  }

  /** 返回默认脱敏的会话导出。 */
  export(sessionId: string, options?: RedactionOptions): ObservatoryExport {
    return this.collector.export(sessionId, options)
  }

  /** 更新会话标题和工作区。 */
  describe(sessionId: string, metadata: { title?: string; workspace?: string }): void {
    this.collector.describe(sessionId, metadata)
  }

  /** 清空指定会话或全部内存观测数据。 */
  clear(sessionId?: string): void {
    this.collector.clear(sessionId)
  }
}
