import { ObservatoryCollector } from '../core.ts'
import type { RawSessionEvent, RuntimeNode } from '../model.ts'

const BASE_TIME = Date.now() - 24_000

const events: RawSessionEvent[] = [
  { type: 'turn/start', seq: 1, time: BASE_TIME, data: { turn: 7 } },
  { type: 'step/start', seq: 2, time: BASE_TIME + 120, data: { turn: 7, step: 1 } },
  {
    type: 'request/context', seq: 3, time: BASE_TIME + 180,
    data: { provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 131_072 },
  },
  {
    type: 'request/header', seq: 4, time: BASE_TIME + 210,
    data: {
      reason: 'change',
      header: {
        config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        system: 'You are a software engineering agent. Inspect evidence before changing files. Follow workspace instructions and report verification results.',
        tools: [
          { name: 'read_file', description: 'Read a UTF-8 text file from the workspace.', parameters: { path: { type: 'string' } } },
          { name: 'bash', description: 'Run a shell command in the active workspace.', parameters: { command: { type: 'string' } } },
          { name: 'web_search', description: 'Search the web and return structured sources.', parameters: { query: { type: 'string' } } },
          { name: 'apply_patch', description: 'Apply a scoped patch to workspace files.', parameters: { patch: { type: 'string' } } },
        ],
      },
    },
  },
  { type: 'tool/call', seq: 5, time: BASE_TIME + 1_100, data: { turn: 7, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"src/runtime.ts"}' } },
  { type: 'tool/result', seq: 6, time: BASE_TIME + 1_238, data: { turn: 7, step: 1, message: { toolCallId: 'call-1', content: '164 lines' } } },
  { type: 'tool/call', seq: 7, time: BASE_TIME + 2_040, data: { turn: 7, step: 1, callId: 'call-2', name: 'bash', arguments: '{"command":"pnpm test"}' } },
  { type: 'tool/result', seq: 8, time: BASE_TIME + 6_890, data: { turn: 7, step: 1, message: { toolCallId: 'call-2', content: '28 tests passed' } } },
  {
    type: 'assistant/message', seq: 9, time: BASE_TIME + 8_400,
    data: { turn: 7, step: 1, message: { role: 'assistant', content: 'The runtime path is verified.' }, usage: { inputTokens: 12_480, outputTokens: 842 } },
  },
  { type: 'step/end', seq: 10, time: BASE_TIME + 8_430, data: { turn: 7, step: 1 } },
  { type: 'step/start', seq: 11, time: BASE_TIME + 8_660, data: { turn: 7, step: 2 } },
  { type: 'tool/call', seq: 12, time: BASE_TIME + 9_020, data: { turn: 7, step: 2, callId: 'call-3', name: 'apply_patch', arguments: '{"patch":"*** Begin Patch"}' } },
  { type: 'tool/result', seq: 13, time: BASE_TIME + 9_410, data: { turn: 7, step: 2, message: { toolCallId: 'call-3', content: 'Done' } } },
  { type: 'assistant/message', seq: 14, time: BASE_TIME + 11_100, data: { turn: 7, step: 2, message: { role: 'assistant', content: 'Implementation complete.' }, usage: { inputTokens: 8_102, outputTokens: 506 } } },
  { type: 'step/end', seq: 15, time: BASE_TIME + 11_130, data: { turn: 7, step: 2 } },
  { type: 'turn/end', seq: 16, time: BASE_TIME + 11_160, data: { turn: 7, reason: { kind: 'completed' } } },
]

const runtime: RuntimeNode[] = [
  {
    id: 'profile:web', name: 'web', kind: 'profile', status: 'active', children: [
      { id: 'bundle:base', name: '@deepseek-ai/dsh-base', kind: 'bundle', status: 'active', children: [
        { id: 'plugin:agent-loop', name: 'agent-loop', kind: 'plugin', provider: '@deepseek-ai/dsh-agent-loop', status: 'active' },
        { id: 'plugin:tools', name: 'tools', kind: 'service', provider: '@deepseek-ai/dsh-tools', status: 'active' },
        { id: 'plugin:session', name: 'sessions', kind: 'service', provider: '@deepseek-ai/dsh-session', status: 'active' },
      ] },
      { id: 'bundle:web', name: '@deepseek-ai/dsh-web-app', kind: 'bundle', status: 'active' },
      { id: 'bundle:observatory', name: 'dsh-observatory', kind: 'bundle', status: 'active' },
    ],
  },
]

const collector = new ObservatoryCollector({ now: () => BASE_TIME + 11_160 })
for (const event of events) collector.record('demo-7f2d9a4e', event)
collector.describe('demo-7f2d9a4e', {
  title: 'Observatory MVP · runtime inspection',
  workspace: '/Users/demo/projects/dsh-observatory',
})

export const demoSnapshot = collector.snapshot('demo-7f2d9a4e', runtime)
