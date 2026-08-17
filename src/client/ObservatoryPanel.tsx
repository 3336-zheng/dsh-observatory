import { useEffect, useMemo, useState, type ComponentType, type SVGProps } from 'react'
import {
  Activity,
  AlertTriangle,
  Bot,
  Braces,
  ChevronRight,
  CircleDot,
  Clock3,
  Download,
  FileText,
  Gauge,
  Layers3,
  RefreshCw,
  Save,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ObservatorySnapshot, RuntimeNode, TimelineEvent } from '../model.ts'
import { redactValue } from '../redaction.ts'
import type { ConfigFile, ConfigKind, ConfigReadValue } from '../config-types.ts'
import { ConfigSource } from './config-source.ts'
import { deriveClientSnapshot } from './normalize.ts'
import type { CurrentSessionValue } from './sources.ts'
import css from './observatory.module.css'

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: string | number; strokeWidth?: string | number }>
type View = 'overview' | 'trace' | 'context' | ConfigKind

export interface ObservatoryPanelFace {
  hooks: {
    observatory: { getSnapshot(): CurrentSessionValue; subscribe(listener: () => void): () => void }
    runtime: { getSnapshot(): readonly RuntimeNode[]; subscribe(listener: () => void): () => void }
  }
  config: ConfigSource
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

function runtimeRole(kind: RuntimeNode['kind']): string {
  return {
    profile: '工作环境',
    bundle: '功能集合',
    plugin: '能力模块',
    service: '后台服务',
    slot: '挂载位置',
  }[kind]
}

function runtimeName(node: RuntimeNode): string {
  const labels: Record<string, string> = {
    web: 'Web 工作区',
    root: '主运行区',
    sidebar: '侧边栏',
    'sidebar.footer.action': '侧边栏操作区',
    layout: '界面布局',
    'agent-loop': 'Agent 执行',
    tools: '工具能力',
    sessions: '会话管理',
    'dsh-observatory': 'Observatory 观测',
  }
  return labels[node.name] ?? node.name
}

function runtimeSize(node: RuntimeNode): number {
  return 1 + (node.children?.reduce((sum, child) => sum + runtimeSize(child), 0) ?? 0)
}

function runtimeStatus(status: RuntimeNode['status']): string {
  return { active: '已启用', waiting: '等待中', failed: '异常' }[status]
}

function RuntimeBranch({ node, depth = 0 }: { node: RuntimeNode; depth?: number }) {
  const childCount = node.children?.length ?? 0
  const descendantCount = runtimeSize(node) - 1
  return (
    <li>
      <details className={css.runtimeItem}>
        <summary className={css.runtimeRow} style={{ paddingLeft: 10 + depth * 18 }}>
          <ChevronRight size={13} />
          <span className={css.runtimeCopy}>
            <strong>{runtimeName(node)}</strong>
            <small>{runtimeRole(node.kind)}{descendantCount > 0 ? ` · ${String(descendantCount)} 项` : ''}</small>
          </span>
          <span className={css.runtimeState} data-status={node.status}>{runtimeStatus(node.status)}</span>
        </summary>
        {node.provider !== undefined && (
          <div className={css.runtimeDetail}>来源：<code>{node.provider}</code></div>
        )}
        {childCount > 0 && (
          <ul>{node.children?.map(child => <RuntimeBranch key={child.id} node={child} depth={depth + 1} />)}</ul>
        )}
      </details>
    </li>
  )
}

const CONFIG_PAGE: Record<ConfigKind, { title: string; eyebrow: string; description: string }> = {
  skills: { title: 'Skills', eyebrow: 'SKILLS', description: '可复用的工作方法和指令' },
  mcp: { title: 'MCP 服务', eyebrow: 'MCP', description: '外部工具服务的本地配置' },
  agents: { title: 'Sub-agent', eyebrow: 'SUB-AGENT', description: '子 Agent 的预设与行为配置' },
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
}

function ConfigManager({ config, kind }: { config: ConfigSource; kind: ConfigKind }) {
  const page = CONFIG_PAGE[kind]
  const [files, setFiles] = useState<readonly ConfigFile[]>([])
  const [root, setRoot] = useState('')
  const [selectedId, setSelectedId] = useState<string>()
  const [document, setDocument] = useState<ConfigReadValue>()
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(undefined)
    void config.list(kind).then(value => {
      if (!active) return
      setRoot(value.root)
      setFiles(value.files)
      setSelectedId(current => current !== undefined && value.files.some(file => file.id === current)
        ? current : value.files[0]?.id)
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : '读取配置目录失败')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [config, kind, refresh])

  useEffect(() => {
    if (selectedId === undefined) {
      setDocument(undefined)
      setDraft('')
      return
    }
    let active = true
    setReading(true)
    setNotice(undefined)
    setError(undefined)
    void config.read(kind, selectedId).then(value => {
      if (!active) return
      setDocument(value)
      setDraft(value.content)
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : '读取配置文件失败')
    }).finally(() => { if (active) setReading(false) })
    return () => { active = false }
  }, [config, kind, selectedId])

  const dirty = document !== undefined && draft !== document.content
  const save = () => {
    if (selectedId === undefined || document === undefined || saving) return
    setSaving(true)
    setNotice(undefined)
    setError(undefined)
    void config.write(kind, selectedId, draft, document.file.modifiedAt).then(value => {
      setDocument(current => current === undefined ? current : { ...current, file: value.file })
      setFiles(current => current.map(file => file.id === value.file.id ? value.file : file))
      setNotice('已保存到本地 .dsh')
    }).catch(reason => {
      setError(reason instanceof Error ? reason.message : '保存失败')
    }).finally(() => { setSaving(false) })
  }

  return (
    <section className={`${css.band} ${css.configPage}`}>
      <div className={css.configHeader}>
        <div><span className={css.eyebrow}>{page.eyebrow}</span><h2>{page.title}</h2><p>{page.description}</p></div>
        <div className={css.configActions}>
          <span className={css.configRoot}>{root || '.dsh'}</span>
          <button type="button" className={css.iconButton} aria-label="刷新文件列表" title="刷新文件列表" onClick={() => { setRefresh(value => value + 1) }}><RefreshCw size={15} /></button>
          <button type="button" className={css.saveButton} disabled={!dirty || saving || reading} onClick={save}><Save size={14} />{saving ? '保存中' : '保存修改'}</button>
        </div>
      </div>
      {error !== undefined && <div className={css.configNotice} data-tone="error">{error}</div>}
      {notice !== undefined && <div className={css.configNotice} data-tone="success">{notice}</div>}
      <div className={css.configLayout}>
        <div className={css.configFiles}>
          <div className={css.configFilesHead}><span>文件</span><span>{files.length}</span></div>
          {loading && <div className={css.configEmpty}>正在读取…</div>}
          {!loading && files.length === 0 && <div className={css.configEmpty}>目录中暂无文件</div>}
          {files.map(file => (
            <button type="button" key={file.id} className={file.id === selectedId ? `${css.configFile} ${css.configFileActive}` : css.configFile} onClick={() => { setSelectedId(file.id) }}>
              <FileText size={14} />
              <span><strong>{file.relativePath.split('/').at(-1)}</strong><small>{formatBytes(file.bytes)} · {file.format}</small></span>
            </button>
          ))}
        </div>
        <div className={css.configEditor}>
          {selectedId === undefined
            ? <div className={css.configEmpty}><FileText size={20} /><span>选择一个文件开始查看</span></div>
            : <>
              <div className={css.configEditorHead}><strong>{selectedId}</strong>{document?.redacted === true && <span>已隐藏敏感值</span>}</div>
              <textarea value={draft} disabled={reading || saving} onChange={event => { setDraft(event.target.value) }} spellCheck={false} aria-label={`${page.title} 文件内容`} />
            </>}
        </div>
      </div>
    </section>
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

interface ConversationBlock {
  readonly id: string
  readonly turn?: number
  readonly events: readonly TimelineEvent[]
}

function conversationBlocks(events: readonly TimelineEvent[]): ConversationBlock[] {
  const groups = new Map<string, TimelineEvent[]>()
  for (const event of events) {
    const id = event.turn === undefined ? `category:${event.category}` : `turn:${String(event.turn)}`
    const group = groups.get(id)
    if (group === undefined) groups.set(id, [event])
    else group.push(event)
  }
  return [...groups.entries()]
    .map(([id, grouped]) => ({ id, turn: grouped[0]?.turn, events: grouped }))
    .sort((left, right) => (right.events.at(-1)?.time ?? 0) - (left.events.at(-1)?.time ?? 0))
}

function ConversationBlocks({ events, selectedId, onSelect, compact = false }: {
  events: readonly TimelineEvent[]
  selectedId?: string
  onSelect(event: TimelineEvent): void
  compact?: boolean
}) {
  const blocks = conversationBlocks(events)
  if (blocks.length === 0) return <div className={css.emptyState}>当前会话暂无可展示事件</div>
  return (
    <div className={css.conversationBlocks}>
      {blocks.map(block => {
        const last = block.events.at(-1)
        return (
          <details className={css.conversationBlock} key={block.id}>
            <summary>
              <span className={css.conversationBlockTitle}>
                <span className={css.eyebrow}>{block.turn === undefined ? 'SYSTEM' : 'TURN'}</span>
                <strong>{block.turn === undefined ? '上下文与系统事件' : `Turn ${String(block.turn)}`}</strong>
              </span>
              <span className={css.conversationBlockSummary}>
                {block.events[0]?.title ?? '对话事件'}
              </span>
              <span className={css.conversationBlockMeta}>
                {block.events.length} events{last === undefined ? '' : ` · ${formatTime(last.time)}`}
              </span>
              <ChevronRight size={15} />
            </summary>
            <TimelineRows events={block.events} selectedId={selectedId} onSelect={onSelect} compact={compact} />
          </details>
        )
      })}
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
        <ConversationBlocks events={snapshot.timeline} selectedId={selectedId} onSelect={onSelect} compact />
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
            <div><span className={css.eyebrow}>能力</span><h2>已启用能力</h2></div>
            <span className={css.sectionMeta}>{snapshot.runtime.reduce((sum, node) => sum + runtimeSize(node), 0)} 项运行组件</span>
          </div>
          {snapshot.runtime.length === 0
            ? <div className={css.emptyState}>暂无已启用能力信息</div>
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
      <ConversationBlocks events={filtered} selectedId={selectedId} onSelect={onSelect} />
    </section>
  )
}

function ContextView({ snapshot }: { snapshot: ObservatorySnapshot }) {
  const total = snapshot.context.reduce((sum, item) => sum + item.estimatedTokens, 0)
  const orderedContext = useMemo(() => [...snapshot.context].sort((left, right) => (
    right.estimatedTokens - left.estimatedTokens || left.name.localeCompare(right.name)
  )), [snapshot.context])
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
          {orderedContext.map(item => {
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

export function ObservatoryWorkbench({ snapshot, onClose, config }: {
  snapshot: ObservatorySnapshot
  onClose?: () => void
  config?: ConfigSource
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
          <div className={css.navGroup}><span>管理</span>
            <NavItem active={view === 'skills'} icon={Sparkles} label="Skills" onClick={() => { changeView('skills') }} />
            <NavItem active={view === 'mcp'} icon={Server} label="MCP 服务" onClick={() => { changeView('mcp') }} />
            <NavItem active={view === 'agents'} icon={Bot} label="Sub-agent" onClick={() => { changeView('agents') }} />
          </div>
          <div className={css.navFoot}><Clock3 size={14} /><span>{formatTime(snapshot.updatedAt)} 更新</span></div>
        </nav>
        <main className={css.main}>
          {view === 'overview' && <Overview snapshot={snapshot} selectedId={selectedId} onSelect={select} />}
          {view === 'trace' && <TraceView snapshot={snapshot} selectedId={selectedId} onSelect={select} />}
          {view === 'context' && <ContextView snapshot={snapshot} />}
          {view === 'skills' && config !== undefined && <ConfigManager config={config} kind="skills" />}
          {view === 'mcp' && config !== undefined && <ConfigManager config={config} kind="mcp" />}
          {view === 'agents' && config !== undefined && <ConfigManager config={config} kind="agents" />}
        </main>
        <Inspector event={selected} open={inspectorOpen} onClose={() => { setInspectorOpen(false) }} />
      </div>
    </div>
  )
}

export function ObservatoryPanel({ wide, useSessions, useObservatory, useRuntime, config }: ObservatoryPanelProps) {
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
      {open && <ObservatoryWorkbench snapshot={snapshot} config={config} onClose={() => { setOpen(false) }} />}
    </div>
  )
}

export function ObservatoryErrorBoundaryFallback() {
  return <div className={css.errorFallback}><AlertTriangle size={15} />Observatory 加载失败</div>
}
