import { fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import goalBoardHtml from '../../public/goal-board.html?raw'

const workspace = {
  version: 1,
  templates: [],
  workingCopies: [{
    id: 'copy-test',
    sourceTemplateId: 'template-test',
    sourceTemplateTitle: '测试母版',
    title: '测试副本',
    variables: [
      { name: 'TEST_ENV', value: 'BOECN' },
      { name: 'TEST_HINTS', value: '大段测试内容' },
    ],
    body: '完整 Goal 正文',
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
  }],
  activeItem: { kind: 'copy', id: 'copy-test' },
}

const loadGoalBoard = async (fetchMock: ReturnType<typeof vi.fn>) => {
  const script = goalBoardHtml.match(/<script>([\s\S]*)<\/script>/)?.[1]
  if (!script) throw new Error('Goal 工作台脚本缺失')

  document.open()
  document.write(goalBoardHtml.replace(/<script>[\s\S]*<\/script>/, ''))
  document.close()
  vi.stubGlobal('fetch', fetchMock)
  window.eval(script)

  await waitFor(() => {
    expect(document.querySelectorAll('.expand-editor')).toHaveLength(3)
  })
}

describe('Goal 工作台编辑入口', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('只在点击打开编辑按钮时打开大编辑器', async () => {
    await loadGoalBoard(vi.fn(async () => new Response(JSON.stringify(workspace), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    const modal = document.getElementById('editor-modal')
    const hintsTextarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="TEST_HINTS 的值"]')
    expect(modal).toHaveAttribute('aria-hidden', 'true')
    expect(hintsTextarea).not.toBeNull()
    expect([...document.querySelectorAll<HTMLButtonElement>('.expand-editor')]
      .every(button => button.textContent === '打开编辑')).toBe(true)

    fireEvent.click(hintsTextarea!)
    expect(modal).toHaveAttribute('aria-hidden', 'true')

    const hintsOpenButton = hintsTextarea!
      .closest('[data-copy-variable-index]')
      ?.querySelector<HTMLButtonElement>('[data-expand-variable]')
    expect(hintsOpenButton).not.toBeNull()
    fireEvent.click(hintsOpenButton!)
    expect(modal).toHaveAttribute('aria-hidden', 'false')
  })

  it('落盘完整 Goal 并复制返回的绝对路径', async () => {
    const path = '/Users/test/promptgoal/attachments/copy-test/20260831-120000-000.md'
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === '/api/goal-dump') {
        return new Response(JSON.stringify({ path }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(workspace), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    await loadGoalBoard(fetchMock)

    fireEvent.click(document.getElementById('dump-goal')!)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(path))
    const dumpCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/goal-dump')
    expect(dumpCall).toBeDefined()
    expect(dumpCall?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(JSON.parse(String(dumpCall?.[1]?.body))).toEqual({
      workingCopyId: 'copy-test',
      text: '【变量区】\nTEST_ENV = BOECN\nTEST_HINTS = 大段测试内容\n\n【执行区】\n完整 Goal 正文',
    })
    expect(document.getElementById('dump-feedback')).toHaveTextContent('完整 Goal 已落盘，路径已复制。')
    expect(document.getElementById('dump-feedback')).toHaveTextContent(path)
    expect(document.getElementById('dump-goal')).toBeEnabled()
  })

  it('落盘失败时保留当前 Goal 并允许重试', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === '/api/goal-dump') {
        return new Response(JSON.stringify({ message: '磁盘写入失败' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(workspace), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await loadGoalBoard(fetchMock)

    fireEvent.click(document.getElementById('dump-goal')!)

    await waitFor(() => {
      expect(document.getElementById('dump-feedback')).toHaveTextContent('磁盘写入失败，完整 Goal 未落盘，可重试。')
    })
    expect(document.getElementById('copy-body')).toHaveValue('完整 Goal 正文')
    expect(document.getElementById('dump-goal')).toBeEnabled()
  })
})
