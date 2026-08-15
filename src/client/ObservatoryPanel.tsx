import { useEffect, useMemo, useState, type ComponentType, type SVGProps } from 'react'
import {
  Activity,
  AlertTriangle,
  Braces,
  ChevronRight,
  CircleDot,
  Clock3,
  Download,
  Gauge,
  Layers3,
  Search,
  ShieldCheck,
  Wrench,
  X,
} from 'lucide-react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ObservatorySnapshot, RuntimeNode, TimelineEvent } from '../model.ts'
import { redactValue } from '../redaction.ts'
import { deriveClientSnapshot } from './normalize.ts'
import type { CurrentSessionValue } from './sources.ts'
import css from './observatory.module.css'

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: string | number; strokeWidth?: string | number }>
type View = 'overview' | 'trace' | 'context'

export interface ObservatoryPanelFace {
  hooks: {
    observatory: { getSnapshot(): CurrentSessionValue; subscribe(listener: () => void): () => void }
    runtime: { getSnapshot(): readonly RuntimeNode[]; subscribe(listener: () => void): () => void }
  }
}

export type ObservatoryPanelProps =
  PropsRuntime<'sidebar.footer.action'>
  & InjectFace<ObservatoryPanelFace>

function formatDuration(durationMs?: number): string {
  if (durationMs === undefined) return '—'
  if (durationMs < 1_000) return `${String(durationMs)} ms`
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(value)
}

function statusLabel(status: ObservatorySnapshot['status']): string {
  return { idle: '空闲', running: '运行中', attention: '需关注', error: '异常' }[status]
}

function statusClass(status: TimelineEvent['status']): string {
  return `${css.eventDot} ${css[`status_${status}`]}`
}

function NavItem({ active, icon: IconView, label, count, onClick }: {
  active: boolean
  icon: Icon
  label: string
  count?: number
  onClick(): void
}) {
  return (
    <button type="button" className={active ? `${css.navItem} ${css.navActive}` : css.navItem} onClick={onClick}>
      <IconView size={16} strokeWidth={1.8} />
      <span>{label}</span>
      {count !== undefined && <span className={css.navCount}>{count}</span>}
    </button>
  )
}

function MetricStrip({ snapshot }: { snapshot: ObservatorySnapshot }) {
  return (
    <div className={css.metricStrip}>
      {snapshot.metrics.map(metric => (
        <div className={css.metric} data-tone={metric.tone} key={metric.label}>
          <span className={css.metricLabel}>{metric.label}</span>
          <strong>{metric.value}</strong>
          <span className={css.metricHint}>{metric.hint}</span>
        </div>
      ))}
    </div>
  )
}

function RuntimeBranch({ node, depth = 0 }: { node: RuntimeNode; depth?: number }) {
  const childCount = node.children?.length ?? 0
  return (
    <li>
      <div className={css.runtimeRow} style={{ paddingLeft: 10 + depth * 18 }}>
        {childCount > 0 ? <ChevronRight size={13} /> : <span className={css.runtimeSpacer} />}
        <span className={css.runtimeKind}>{node.kind}</span>
        <span className={css.runtimeName}>{node.name}</span>
        {node.provider !== undefined && <span className={css.runtimeProvider}>{node.provider}</span>}
        <span className={css.runtimeState} data-status={node.status}>{node.status}</span>
      </div>
      {node.children !== undefined && (
        <ul>{node.children.map(child => <RuntimeBranch key={child.id} node={child} depth={depth + 1} />)}</ul>
      )}
    </li>
  )
}

function TimelineRows({ events, selectedId, onSelect, compact = false }: {
  events: readonly TimelineEvent[]
  selectedId?: string
  onSelect(event: TimelineEvent): void
  compact?: boolean
}) {
  if (events.length === 0) return <div className={css.emptyState}>当前会话暂无可展示事件</div>
  return (
    <div className={compact ? `${css.timeline} ${css.timelineCompact}` : css.timeline}>
      {events.map(event => (
        <button
          type="button"
          className={event.id === selectedId ? `${css.eventRow} ${css.eventSelected}` : css.eventRow}
          key={event.id}
          onClick={() => { onSelect(event) }}
        >
          <span className={css.eventRail}><span className={statusClass(event.status)} /></span>
          <span className={css.eventBody}>
            <span className={css.eventTitle}>{event.title}</span>
            {event.detail !== undefined && <span className={css.eventDetail}>{event.detail}</span>}
          </span>
          <span className={css.eventMeta}>
            <span>{event.turn === undefined ? event.category : `T${String(event.turn)}${event.step === undefined ? '' : ` · S${String(event.step)}`}`}</span>
            <span>{event.durationMs === undefined ? formatTime(event.time) : formatDuration(event.durationMs)}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

function Overview({ snapshot, selectedId, onSelect }: {
  snapshot: ObservatorySnapshot
  selectedId?: string
  onSelect(event: TimelineEvent): void
}) {
  return (
    <div className={css.viewStack}>
      <MetricStrip snapshot={snapshot} />
      <section className={css.band}>
        <div className={css.sectionHead}>
          <div><span className={css.eyebrow}>LIVE</span><h2>最近活动</h2></div>
          <span className={css.sectionMeta}>{snapshot.timeline.length} events</span>
        </div>
        <TimelineRows events={snapshot.timeline.slice(-6).reverse()} selectedId={selectedId} onSelect={onSelect} compact />
      </section>
      <div className={css.splitSections}>
        <section className={css.band}>
          <div className={css.sectionHead}>
            <div><span className={css.eyebrow}>TOOLS</span><h2>工具表现</h2></div>
          </div>
          <div className={css.tableWrap}>
            <table>
              <thead><tr><th>工具</th><th>调用</th><th>失败</th><th>平均耗时</th></tr></thead>
              <tbody>
                {snapshot.tools.length === 0 && <tr><td colSpan={4} className={css.emptyCell}>暂无工具调用</td></tr>}
                {snapshot.tools.map(tool => (
                  <tr key={tool.name}>
                    <td><span className={css.toolName}><Wrench size={14} />{tool.name}</span></td>
                    <td>{tool.calls}</td><td data-danger={tool.failures > 0 || undefined}>{tool.failures}</td>
                    <td>{formatDuration(tool.averageDurationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className={css.band}>
          <div className={css.sectionHead}>
            <div><span className={css.eyebrow}>RUNTIME</span><h2>插件与插槽</h2></div>
            <span className={css.sectionMeta}>{snapshot.runtime.length} roots</span>
          </div>
          {snapshot.runtime.length === 0
            ? <div className={css.emptyState}>运行时拓扑尚未就绪</div>
            : <ul className={css.runtimeTree}>{snapshot.runtime.slice(0, 5).map(node => <RuntimeBranch key={node.id} node={node} />)}</ul>}
        </section>
      </div>
    </div>
  )
}

function TraceView({ snapshot, selectedId, onSelect }: {
  snapshot: ObservatorySnapshot
  selectedId?: string
  onSelect(event: TimelineEvent): void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | TimelineEvent['category']>('all')
  const filtered = useMemo(() => snapshot.timeline.filter(event => {
    const matchesCategory = filter === 'all' || event.category === filter
    const needle = query.trim().toLowerCase()
    return matchesCategory && (needle === '' || `${event.title} ${event.detail ?? ''} ${event.type}`.toLowerCase().includes(needle))
  }).reverse(), [filter, query, snapshot.timeline])
  return (
    <section className={css.band}>
      <div className={css.traceToolbar}>
        <div className={css.searchBox}><Search size={15} /><input aria-label="搜索事件" value={query} onChange={event => { setQuery(event.target.value) }} placeholder="搜索事件" /></div>
        <div className={css.segmented} aria-label="事件类型">
          {(['all', 'turn', 'model', 'tool', 'context'] as const).map(value => (
            <button type="button" key={value} data-active={filter === value || undefined} onClick={() => { setFilter(value) }}>
              {{ all: '全部', turn: 'Turn', model: '模型', tool: '工具', context: '上下文' }[value]}
            </button>
          ))}
        </div>
      </div>
      <TimelineRows events={filtered} selectedId={selectedId} onSelect={onSelect} />
    </section>
  )
}

function ContextView({ snapshot }: { snapshot: ObservatorySnapshot }) {
  const total = snapshot.context.reduce((sum, item) => sum + item.estimatedTokens, 0)
  return (
    <div className={css.viewStack}>
      <section className={css.contextSummary}>
        <div><span className={css.eyebrow}>REQUEST</span><h2>{snapshot.request?.model ?? '当前模型'}</h2></div>
        <dl>
          <div><dt>Provider</dt><dd>{snapshot.request?.provider ?? 'unknown'}</dd></div>
          <div><dt>上下文</dt><dd>{total.toLocaleString()} tokens</dd></div>
          <div><dt>工具</dt><dd>{snapshot.context.filter(item => item.kind === 'tool-schema').length}</dd></div>
        </dl>
      </section>
      <section className={css.band}>
        <div className={css.sectionHead}>
          <div><span className={css.eyebrow}>CONTEXT</span><h2>来源与占用</h2></div>
          <span className={css.sectionMeta}>约 {total.toLocaleString()} tokens</span>
        </div>
        <div className={css.contextRows}>
          {snapshot.context.length === 0 && <div className={css.emptyState}>当前客户端快照未包含上下文详情</div>}
          {snapshot.context.map(item => {
            const share = total === 0 ? 0 : Math.max(2, Math.round(item.estimatedTokens / total * 100))
            return (
              <details className={css.contextRow} key={item.id}>
                <summary>
                  <span className={css.contextIcon}>{item.kind === 'tool-schema' ? <Braces size={15} /> : <Layers3 size={15} />}</span>
                  <span className={css.contextName}><strong>{item.name}</strong><small>{item.source}</small></span>
                  <span className={css.tokenBar}><i style={{ width: `${String(share)}%` }} /></span>
                  <span className={css.tokenValue}>{item.estimatedTokens.toLocaleString()}</span>
                  <ChevronRight size={14} />
                </summary>
                {item.detail !== undefined && <pre>{item.detail}</pre>}
              </details>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function Inspector({ event, open, onClose }: {
  event?: TimelineEvent
  open: boolean
  onClose(): void
}) {
  if (event === undefined) {
    return <aside className={css.inspector}><div className={css.inspectorEmpty}><CircleDot size={20} /><span>选择事件查看详情</span></div></aside>
  }
  const payload = JSON.stringify(redactValue(event.payload), null, 2)
  return (
    <aside className={css.inspector} data-open={open || undefined}>
      <header>
        <span className={statusClass(event.status)} />
        <div><strong>{event.title}</strong><small>{event.type}</small></div>
        {open && <button type="button" className={css.inspectorClose} aria-label="关闭事件详情" title="关闭事件详情" onClick={onClose}><X size={17} /></button>}
      </header>
      <dl className={css.detailGrid}>
        <div><dt>时间</dt><dd>{formatTime(event.time)}</dd></div>
        <div><dt>耗时</dt><dd>{formatDuration(event.durationMs)}</dd></div>
        <div><dt>Turn</dt><dd>{event.turn ?? '—'}</dd></div>
        <div><dt>Step</dt><dd>{event.step ?? '—'}</dd></div>
      </dl>
      <div className={css.payloadHead}><span>Payload</span><ShieldCheck size={14} /><small>已脱敏</small></div>
      <pre className={css.payload}>{payload ?? 'null'}</pre>
    </aside>
  )
}

function downloadSnapshot(snapshot: ObservatorySnapshot): void {
  const payload = redactValue({
    format: 'dsh-observatory/v1',
    exportedAt: new Date().toISOString(),
    snapshot,
  })
  const href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = `dsh-observatory-${snapshot.sessionId ?? 'session'}.json`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => { URL.revokeObjectURL(href) }, 0)
}

export function ObservatoryWorkbench({ snapshot, onClose }: {
  snapshot: ObservatorySnapshot
  onClose?: () => void
}) {
  const [view, setView] = useState<View>('overview')
  const [selectedId, setSelectedId] = useState<string | undefined>(() => snapshot.timeline.at(-1)?.id)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  useEffect(() => {
    if (selectedId !== undefined && snapshot.timeline.some(event => event.id === selectedId)) return
    setSelectedId(snapshot.timeline.at(-1)?.id)
  }, [selectedId, snapshot.timeline])
  const selected = snapshot.timeline.find(event => event.id === selectedId)
  const select = (event: TimelineEvent) => {
    setSelectedId(event.id)
    setInspectorOpen(true)
  }
  const changeView = (next: View) => {
    setView(next)
    setInspectorOpen(false)
  }

  return (
    <div className={css.workbench} data-testid="observatory-workbench">
      <header className={css.topbar}>
        <div className={css.product}><Activity size={18} /><strong>DSH Observatory</strong><span>Developer Preview</span></div>
        <div className={css.sessionTitle}>
          <span className={css.liveDot} data-status={snapshot.status} />
          <div><strong>{snapshot.sessionTitle}</strong><small>{snapshot.workspace ?? 'DeepSeek Harness'}</small></div>
        </div>
        <div className={css.topActions}>
          <span className={css.statusPill} data-status={snapshot.status}>{statusLabel(snapshot.status)}</span>
          <button type="button" className={css.iconButton} aria-label="导出会话" title="导出会话" onClick={() => { downloadSnapshot(snapshot) }}><Download size={16} /></button>
          {onClose !== undefined && <button type="button" className={css.iconButton} aria-label="关闭工作台" title="关闭工作台" onClick={onClose}><X size={18} /></button>}
        </div>
      </header>
      <div className={css.body}>
        <nav className={css.nav} aria-label="Observatory 视图">
          <div className={css.navGroup}><span>观察</span>
            <NavItem active={view === 'overview'} icon={Gauge} label="概览" onClick={() => { changeView('overview') }} />
            <NavItem active={view === 'trace'} icon={Activity} label="执行轨迹" count={snapshot.timeline.length} onClick={() => { changeView('trace') }} />
            <NavItem active={view === 'context'} icon={Braces} label="上下文" count={snapshot.context.length} onClick={() => { changeView('context') }} />
          </div>
          <div className={css.navFoot}><Clock3 size={14} /><span>{formatTime(snapshot.updatedAt)} 更新</span></div>
        </nav>
        <main className={css.main}>
          {view === 'overview' && <Overview snapshot={snapshot} selectedId={selectedId} onSelect={select} />}
          {view === 'trace' && <TraceView snapshot={snapshot} selectedId={selectedId} onSelect={select} />}
          {view === 'context' && <ContextView snapshot={snapshot} />}
        </main>
        <Inspector event={selected} open={inspectorOpen} onClose={() => { setInspectorOpen(false) }} />
      </div>
    </div>
  )
}

export function ObservatoryPanel({ wide, useSessions, useObservatory, useRuntime }: ObservatoryPanelProps) {
  const [open, setOpen] = useState(false)
  const current = useObservatory(value => value)
  const runtime = useRuntime(value => value)
  const list = useSessions(value => value)
  const summary = current.sessionId === undefined
    ? undefined
    : Object.values(list.byId).find(candidate => String(candidate.id) === current.sessionId)
  const snapshot = useMemo(() => deriveClientSnapshot({
    ...current,
    ...(summary?.displayTitle === undefined ? {} : { title: summary.displayTitle }),
    ...(summary?.cwd === undefined ? {} : { workspace: summary.cwd }),
  }, runtime), [current, runtime, summary?.cwd, summary?.displayTitle])

  return (
    <div className={css.sidebarEntry}>
      <button
        type="button"
        className={css.sidebarButton}
        aria-label="打开 Observatory"
        title="打开 Observatory"
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <Activity size={wide ? 15 : 18} />
        {wide && <><span>Observatory</span><span className={css.sidebarStatus} data-status={snapshot.status} /></>}
      </button>
      {open && <ObservatoryWorkbench snapshot={snapshot} onClose={() => { setOpen(false) }} />}
    </div>
  )
}

export function ObservatoryErrorBoundaryFallback() {
  return <div className={css.errorFallback}><AlertTriangle size={15} />Observatory 加载失败</div>
}
