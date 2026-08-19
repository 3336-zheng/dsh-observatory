import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ObservatoryWorkbench } from '../src/client/ObservatoryPanel.tsx'
import { demoSnapshot } from '../src/demo/demo-data.ts'

afterEach(() => {
  cleanup()
})

describe('ObservatoryWorkbench', () => {
  it('switches between the primary views and exposes event details', () => {
    render(<ObservatoryWorkbench snapshot={demoSnapshot} />)
    expect(screen.getByText('最近活动')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /执行轨迹/ }))
    expect(screen.getByRole('textbox', { name: '搜索事件' })).toBeInTheDocument()
    fireEvent.click(screen.getByText('调用 bash'))
    expect(screen.getByText('Payload')).toBeInTheDocument()
    const closeInspector = screen.getByRole('button', { name: '关闭事件详情' })
    fireEvent.click(closeInspector)
    expect(screen.queryByRole('button', { name: '关闭事件详情' })).not.toBeInTheDocument()
    const navigation = screen.getByRole('navigation', { name: 'Observatory 视图' })
    fireEvent.click(within(navigation).getByRole('button', { name: /上下文/ }))
    expect(screen.getByText('来源与占用')).toBeInTheDocument()
  })

  it('exports the current session as a JSON download', async () => {
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:observatory-export')
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    const exportView = render(<ObservatoryWorkbench snapshot={demoSnapshot} />)
    fireEvent.click(within(exportView.container).getByRole('button', { name: '导出会话' }))

    expect(createObjectUrl).toHaveBeenCalledOnce()
    expect(createObjectUrl.mock.calls[0]?.[0]).toBeInstanceOf(Blob)
    expect(anchorClick).toHaveBeenCalledOnce()
    expect((anchorClick.mock.instances[0] as HTMLAnchorElement).download).toBe(`dsh-observatory-${demoSnapshot.sessionId ?? 'session'}.json`)
    await waitFor(() => { expect(revokeObjectUrl).toHaveBeenCalledWith('blob:observatory-export') })

    vi.restoreAllMocks()
  })

  it('opens manual and AI creation flows for managed configs', async () => {
    const config = {
      list: vi.fn().mockResolvedValue({ root: '.dsh/skills', files: [] }),
      read: vi.fn(), write: vi.fn(), create: vi.fn(), remove: vi.fn(), test: vi.fn(), generate: vi.fn(),
    }
    const view = render(<ObservatoryWorkbench snapshot={demoSnapshot} config={config as never} />)
    const navigation = within(view.container).getByRole('navigation', { name: 'Observatory 视图' })
    fireEvent.click(within(navigation).getByRole('button', { name: 'Skills' }))
    await screen.findByText('目录中暂无文件')
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    expect(screen.getByText('新建配置')).toBeInTheDocument()
    expect(screen.getByDisplayValue('SKILL.md')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭编辑' }))
    fireEvent.click(screen.getByRole('button', { name: 'AI 生成' }))
    expect(screen.getByText('一句话生成配置')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('例如：创建一个审查 API 安全问题的 Skill')).toBeInTheDocument()
  })
})
