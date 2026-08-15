import type { HostObservable, SessionMaybeProvideInfo } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { RuntimeNode } from '../model.ts'
import { runtimeFromSlots } from './normalize.ts'

export interface CurrentSessionValue {
  readonly sessionId?: string
  readonly value?: unknown
}

function isObservable(value: unknown): value is HostObservable<unknown> {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<HostObservable<unknown>>
  return typeof candidate.getSnapshot === 'function' && typeof candidate.subscribe === 'function'
}

/** 把当前会话选择和会话快照合并成一个身份稳定的 Observable。 */
export class CurrentSessionSource implements HostObservable<CurrentSessionValue> {
  private readonly listeners = new Set<() => void>()
  private readonly disposeCurrent: () => void
  private disposeSession: (() => void) | undefined
  private sessionSource: HostObservable<unknown> | undefined
  private current: CurrentSessionValue = {}

  constructor(private readonly source: HostObservable<SessionMaybeProvideInfo>) {
    this.disposeCurrent = source.subscribe(() => { this.rebind() })
    this.rebind()
  }

  getSnapshot = (): CurrentSessionValue => this.current

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    this.disposeSession?.()
    this.disposeCurrent()
    this.listeners.clear()
  }

  private rebind(): void {
    this.disposeSession?.()
    const info = this.source.getSnapshot()
    const candidate = info.hooks.session
    this.sessionSource = isObservable(candidate) ? candidate : undefined
    this.disposeSession = this.sessionSource?.subscribe(() => { this.publish() })
    this.publish()
  }

  private publish(): void {
    const info = this.source.getSnapshot()
    this.current = {
      ...(info.sessionId === undefined ? {} : { sessionId: String(info.sessionId) }),
      ...(this.sessionSource === undefined ? {} : { value: this.sessionSource.getSnapshot() }),
    }
    for (const listener of [...this.listeners]) listener()
  }
}

/** 观测 Client SlotRegistry 的声明和注册变化。 */
export class RuntimeTopologySource implements HostObservable<readonly RuntimeNode[]> {
  private readonly listeners = new Set<() => void>()
  private readonly disposeMutation: () => void
  private current: readonly RuntimeNode[]

  constructor(private readonly ctx: ClientContext) {
    this.current = runtimeFromSlots(ctx.slots.snapshot())
    this.disposeMutation = ctx.on('slots/changed', () => {
      this.current = runtimeFromSlots(ctx.slots.snapshot())
      for (const listener of [...this.listeners]) listener()
    })
  }

  getSnapshot = (): readonly RuntimeNode[] => this.current

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    this.disposeMutation()
    this.listeners.clear()
  }
}
