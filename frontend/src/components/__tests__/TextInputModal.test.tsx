import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { InputSendResult } from '../../contexts/TerminalContext'
import { TextInputModal } from '../TextInputModal'

const renderModal = (
  onSend: (text: string) => InputSendResult | Promise<InputSendResult>,
  onClose = vi.fn(),
) => {
  render(
    <TextInputModal
      isOpen
      onClose={onClose}
      onSend={onSend}
      presetGroups={[]}
      activePresetGroupId=""
      onActivePresetGroupChange={vi.fn()}
      onPresetGroupsChange={vi.fn()}
    />,
  )
  return { onClose }
}

describe('TextInputModal reliable send', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps the complete draft open and out of history when sending fails', async () => {
    const text = 'START 中文 😀\n\n```md\n完整代码块\n```\nEND'
    const onSend = vi.fn<(text: string) => InputSendResult>(() => ({
      ok: false,
      reason: 'disconnected',
    }))
    const { onClose } = renderModal(onSend)
    const textarea = screen.getByPlaceholderText('Type or paste text...')

    fireEvent.change(textarea, { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(text)
      expect(screen.getByRole('alert')).toHaveTextContent('连接已断开')
    })
    expect(textarea).toHaveValue(text)
    expect(sessionStorage.getItem('ttyd_text_input_draft')).toBe(text)
    expect(localStorage.getItem('ttyd_input_history')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('clears, closes, and writes history only after a successful send', async () => {
    const text = '第一行\n第二行\n最后一行'
    const onSend = vi.fn<(text: string) => InputSendResult>(() => ({
      ok: true,
      byteLength: new TextEncoder().encode(text).byteLength,
    }))
    const { onClose } = renderModal(onSend)
    const textarea = screen.getByPlaceholderText('Type or paste text...')

    fireEvent.change(textarea, { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(text)
      expect(textarea).toHaveValue('')
    })
    expect(sessionStorage.getItem('ttyd_text_input_draft')).toBeNull()
    expect(JSON.parse(localStorage.getItem('ttyd_input_history') ?? '[]')).toEqual([text])
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('waits for asynchronous acknowledgement before clearing the draft', async () => {
    const text = '完整的多行\nprompt'
    let resolveSend: (result: InputSendResult) => void = () => undefined
    const onSend = vi.fn(() => new Promise<InputSendResult>(resolve => { resolveSend = resolve }))
    const { onClose } = renderModal(onSend)
    const textarea = screen.getByPlaceholderText('Type or paste text...')

    fireEvent.change(textarea, { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(screen.getByRole('button', { name: '发送中…' })).toBeDisabled()
    expect(textarea).toHaveValue(text)
    expect(onClose).not.toHaveBeenCalled()

    resolveSend({ ok: true, byteLength: new TextEncoder().encode(text).byteLength })
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(sessionStorage.getItem('ttyd_text_input_draft')).toBeNull()
  })

  it('places the caret after appended preset text', async () => {
    const presetText = 'P3 测试补充信息\nTEST_HINTS = '
    render(
      <TextInputModal
        isOpen
        onClose={vi.fn()}
        onSend={() => ({ ok: true, byteLength: 0 })}
        presetGroups={[{
          id: 'mobile',
          label: '移动完整',
          presets: [{ label: 'TEST_HINTS（末尾填写）', text: presetText }],
        }]}
        activePresetGroupId="mobile"
        onActivePresetGroupChange={vi.fn()}
        onPresetGroupsChange={vi.fn()}
      />,
    )
    const textarea = screen.getByPlaceholderText('Type or paste text...') as HTMLTextAreaElement

    fireEvent.click(screen.getByRole('button', { name: 'TEST_HINTS（末尾填写）' }))

    await waitFor(() => {
      expect(textarea).toHaveFocus()
      expect(textarea.selectionStart).toBe(presetText.length)
      expect(textarea.selectionEnd).toBe(presetText.length)
    })
  })

  it('dumps the current draft, copies its path, and leaves the draft unsent', async () => {
    const text = '最新草稿\n包含尚未保存的编辑'
    const path = '/Users/test/promptgoal/20260719-013245-123.md'
    const fetchMock = vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ path }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('fetch', fetchMock)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const onSend = vi.fn<(value: string) => InputSendResult>(() => ({ ok: true, byteLength: 0 }))
    const { onClose } = renderModal(onSend)
    const textarea = screen.getByPlaceholderText('Type or paste text...')

    fireEvent.change(textarea, { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: '落盘并复制路径' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(path))
    expect(fetchMock).toHaveBeenCalledWith('/api/dump-file', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: text,
    }))
    expect(textarea).toHaveValue(text)
    expect(sessionStorage.getItem('ttyd_text_input_draft')).toBe(text)
    expect(onSend).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(localStorage.getItem('ttyd_input_history')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(`已落盘：${path}`)
    expect(screen.getByRole('button', { name: '落盘并复制路径' })).toBeEnabled()
  })

  it('disables dumping for an empty draft', () => {
    renderModal(() => ({ ok: true, byteLength: 0 }))

    expect(screen.getByRole('button', { name: '落盘并复制路径' })).toBeDisabled()
  })

  it('keeps the draft and shows an API error when dumping fails', async () => {
    const text = '不能丢失的草稿'
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ error: 'write_failed', message: '磁盘写入失败' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    ))))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onSend = vi.fn<(value: string) => InputSendResult>(() => ({ ok: true, byteLength: 0 }))
    renderModal(onSend)
    const textarea = screen.getByPlaceholderText('Type or paste text...')

    fireEvent.change(textarea, { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: '落盘并复制路径' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('磁盘写入失败')
    expect(textarea).toHaveValue(text)
    expect(sessionStorage.getItem('ttyd_text_input_draft')).toBe(text)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows the complete path when both clipboard methods fail', async () => {
    const path = '/Users/test/promptgoal/manual-copy.md'
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ path }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.reject(new Error('blocked'))) },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    })
    renderModal(() => ({ ok: true, byteLength: 0 }))

    fireEvent.change(screen.getByPlaceholderText('Type or paste text...'), {
      target: { value: '需要手动复制' },
    })
    fireEvent.click(screen.getByRole('button', { name: '落盘并复制路径' }))

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('已落盘，但自动复制失败')
    expect(status).toHaveTextContent(path)
  })
})
