import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ObservatoryPanel, type ObservatoryPanelFace } from './ObservatoryPanel.tsx'
import { CurrentSessionSource, RuntimeTopologySource } from './sources.ts'

export const inject = ['slots', 'sessions']

/** 注册侧边栏入口，并把 DSH 当前会话映射到 Observatory 工作台。 */
export function apply(ctx: ClientContext): void {
  const observatory = new CurrentSessionSource(ctx.sessions.currentProvideInfo)
  const runtime = new RuntimeTopologySource(ctx)
  ctx.effect(() => () => {
    observatory.dispose()
    runtime.dispose()
  }, 'observatory: data sources')

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-observatory',
    order: 80,
    inject: (): ObservatoryPanelFace => ({ hooks: { observatory, runtime } }),
  }, ObservatoryPanel))
}

export type { ObservatoryPanelFace } from './ObservatoryPanel.tsx'
