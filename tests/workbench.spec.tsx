import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ObservatoryWorkbench } from '../src/client/ObservatoryPanel.tsx'
import { demoSnapshot } from '../src/demo/demo-data.ts'

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
})
