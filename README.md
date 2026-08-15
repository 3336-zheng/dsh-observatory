# DSH Observatory

DeepSeek Harness 的运行时观测与 Session 调试工作台。它在官方侧边栏底部提供入口，复杂信息在完整工作台中展示。

当前版本面向 `DeepSeek Harness 0.1.0-rc.6`。Harness 仍处于 Developer Preview，本项目通过独立的数据核心和 Client 适配层降低上游接口变化的影响。

## 当前能力

- 归一化 Turn、Step、模型请求和工具调用事件
- 展示当前会话状态、执行轨迹和事件详情
- 计算工具调用次数、失败数和耗时
- 从 `request/header` 提取 System Prompt、工具 Schema 和 Token 估算
- 展示 DSH Client SlotRegistry 的插件与插槽拓扑
- 导出带版本号的 JSON，并默认脱敏凭据和用户路径
- 独立运行的 React Demo，不需要 API Key

## 界面结构

- **侧边栏入口**：显示 Observatory 和当前会话状态
- **概览**：关键指标、最近活动、工具表现、运行时拓扑
- **执行轨迹**：事件搜索、类型筛选和时间线
- **上下文**：Prompt、工具 Schema 来源及 Token 估算
- **事件详情**：Turn、Step、耗时和脱敏 Payload

## 环境要求

- Node.js `>=22.19.0`
- pnpm `>=11`
- DeepSeek Harness `0.1.0-rc.6`

## 本地开发

```bash
pnpm install
pnpm dev
```

Demo 默认启动在 `http://127.0.0.1:4173`。端口占用时 Vite 会自动选择下一个可用端口。

完整检查：

```bash
pnpm check
pnpm exec playwright test
```

## 安装到 DeepSeek Harness

先构建插件：

```bash
pnpm install
pnpm build:plugin
```

从本地目录安装到 Web Profile：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-observatory
dsh web
```

发布到 GitHub 后可使用：

```bash
dsh plugin --profile web add github:YOUR_NAME/dsh-observatory
```

Git 安装会触发 `prepare`。pnpm 可能先阻止依赖构建并给出 `allowBuilds` 提示；按 CLI 输出更新 Profile 下的 `pnpm-workspace.yaml` 后重新执行安装。

`package.json` 中的 `dsh.bundle` 指向 `cordis.patch.yml`，安装成功后 Harness 会自动把 Bundle 加入 Profile。`dsh.client` 声明浏览器插件及其依赖。

## 架构

```text
session/event ──> ObservatoryService ──> ObservatoryCollector
                                            │
DSH Client ConversationSnapshot ──> Client normalizer
                                            │
SlotRegistry snapshot ─────────────> React workbench
```

- `src/core.ts`：与 Cordis、React 无关的事件归一化和指标计算
- `src/index.ts`：Host 端 Cordis Service，监听 `session/event`
- `src/client/sources.ts`：当前会话和 SlotRegistry 的响应式适配
- `src/client/normalize.ts`：Client ConversationSnapshot 兼容投影
- `src/client/ObservatoryPanel.tsx`：侧边栏入口与完整工作台
- `src/redaction.ts`：导出前的深度脱敏

## API

### `ObservatoryCollector`

创建独立采集器：

```ts
import { ObservatoryCollector } from 'dsh-observatory'

const collector = new ObservatoryCollector({
  maxEventsPerSession: 2_000,
  now: Date.now,
})
```

参数：

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `maxEventsPerSession` | `number` | `2000` | 每个会话在内存保留的最大事件数，最小为 100 |
| `now` | `() => number` | `Date.now` | 导出和空会话快照使用的时钟 |

构造函数不会进行 I/O，不会抛出业务错误。

### `collector.record(sessionId, event)`

记录 DSH Session Event：

```ts
collector.record('session-1', {
  type: 'tool/call',
  seq: 12,
  time: Date.now(),
  data: { callId: 'call-1', name: 'bash', arguments: '{}' },
})
```

- `sessionId: string`：事件所属会话
- `event: RawSessionEvent`：包含 `type`、`seq`、`time`、`data` 的事件
- 返回值：`void`
- 错误：输入由 DSH 保证为 JSON 兼容值；手工传入不可序列化的 `request/header` 可能导致 Token 估算失败

### `collector.describe(sessionId, metadata)`

```ts
collector.describe('session-1', {
  title: '修复登录流程',
  workspace: '/workspace/app',
})
```

更新会话标题和工作区。字段均为可选，返回 `void`，不存在的会话会自动创建空记录。

### `collector.snapshot(sessionId, runtime?)`

```ts
const snapshot = collector.snapshot('session-1', runtimeTree)
```

- `sessionId: string`：目标会话
- `runtime?: RuntimeNode[]`：可选插件或插槽树
- 返回值：不可依赖内部可变引用的 `ObservatorySnapshot`
- 错误：不存在的会话返回空快照，不抛出错误

### `collector.export(sessionId, options?)`

```ts
const exported = collector.export('session-1', {
  keys: ['token', 'password', 'privateKey'],
  redactPaths: true,
})
```

返回 `ObservatoryExport`，格式标识为 `dsh-observatory/v1`。默认处理常见 Token、API Key、Bearer 凭据和用户目录。脱敏是安全辅助，不应代替导出前人工检查。

### `collector.clear(sessionId?)`

```ts
collector.clear('session-1')
collector.clear()
```

传入会话标识时清空单个会话，不传时清空全部内存数据，返回 `void`。

### `redactValue(value, options?)`

```ts
import { redactValue } from 'dsh-observatory'

const safe = redactValue({ authorization: 'Bearer secret', cwd: '/Users/alice/app' })
```

深度复制输入并返回脱敏结果。循环引用会变为 `[CIRCULAR]`；函数、Symbol 等非 JSON 值原样保留，因此公开导出只应传入 JSON 兼容数据。

### `ctx.observatory`

安装 Host 插件后，其他 Cordis 插件可注入服务：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-observatory'

export const inject = ['observatory']

export function apply(ctx: Context) {
  const snapshot = ctx.observatory.snapshot('session-1')
  console.log(snapshot.timeline.length)
}
```

服务公开 `snapshot`、`export`、`describe` 和 `clear`，行为与采集器对应方法一致。

## 已知限制

- Client 工作台只读取当前已加载的会话窗口，不会为了统计而拉取全部历史。
- DSH Client 快照未携带 `request/header` 时，上下文页只显示当前可获得的信息；Host 采集器仍会保留完整 Header。
- 当前运行时树展示 Client SlotRegistry，Host Cordis 服务依赖图将在后续版本接入。
- Token 使用优先读取 Provider 报告；Prompt 和 Schema 仅使用字符数除以四进行估算。
- 第一版数据保存在进程内存中，重启后依靠 Session 日志重新观察，不创建额外数据库。

## 后续方向

- Host 与 Client 之间的只读诊断 API
- Session 回放、双会话 Diff 和 Eval
- Profile、Bundle、Service Provider 完整拓扑
- Prompt Section 与 Skill 逐项来源追踪
- 自动生成最小 `cordis.patch.yml`
- 插件加载失败和依赖等待诊断

## License

MIT
