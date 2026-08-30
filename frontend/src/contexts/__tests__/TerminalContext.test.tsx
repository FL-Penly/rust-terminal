import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  TerminalProvider,
  useTerminal,
  type InputSendResult,
  type TerminalContextValue,
} from '../TerminalContext'

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  static instances: MockWebSocket[] = []

  readonly url: string
  readyState = MockWebSocket.CONNECTING
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null
  onclose: ((event: { reason: string }) => void) | null = null
  onerror: ((error: unknown) => void) | null = null
  send = vi.fn<(data: ArrayBufferView) => void>()
  close = vi.fn(() => { this.readyState = MockWebSocket.CLOSED })

  constructor(url: string, _protocols?: string | string[]) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  open() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }
}

let contextValue: TerminalContextValue | null = null

const ContextCapture = () => {
  contextValue = useTerminal()
  return null
}

const getContext = (): TerminalContextValue => {
  if (!contextValue) throw new Error('Terminal context was not captured')
  return contextValue
}

describe('TerminalContext', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    MockWebSocket.instances = []
    contextValue = null
    window.history.replaceState({}, '', '/')
  })

  it('returns disconnected without attempting a WebSocket send', () => {
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]

    expect(getContext().sendInput('preserved')).toEqual({ ok: false, reason: 'disconnected' })
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('connects directly to the requested herdr pane', () => {
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)

    render(<TerminalProvider><ContextCapture /></TerminalProvider>)

    expect(MockWebSocket.instances[0].url).toMatch(/\/ws\?mux=herdr&pane=w4%3Ap1$/)
    expect(getContext().mux).toBe('herdr')
    expect(getContext().paneId).toBe('w4:p1')
  })

  it('pastes multiline Herdr text through the acknowledged Codex paste API', async () => {
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    const text = '第一行\n第二行 😀'
    const byteLength = new TextEncoder().encode(text).byteLength
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ success: true, byteLength }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)

    await expect(getContext().submitText(text)).resolves.toEqual({ ok: true, byteLength })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/herdr/paste?pane=w4%3Ap1',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text }),
      }),
    )
  })

  it('returns the Herdr paste error without reporting a false success', async () => {
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'agent_input_unavailable', message: 'not a Codex input' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    ))
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)

    await expect(getContext().submitText('first\nsecond')).resolves.toEqual({
      ok: false,
      reason: 'sendFailed',
      message: 'not a Codex input',
    })
  })

  it('keeps single-line Herdr input on the existing terminal paste path', async () => {
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const pasteResult: InputSendResult = { ok: true, byteLength: 11 }
    const pasteHandler = vi.fn(() => pasteResult)
    getContext().registerPasteHandler(pasteHandler)

    await expect(getContext().submitText('single line')).resolves.toEqual(pasteResult)
    expect(pasteHandler).toHaveBeenCalledWith('single line')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not weaken the multiline safety gate outside Herdr', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const pasteHandler = vi.fn((): InputSendResult => ({
      ok: false,
      reason: 'unsafeMultiline',
    }))
    getContext().registerPasteHandler(pasteHandler)

    await expect(getContext().submitText('first\nsecond')).resolves.toEqual({
      ok: false,
      reason: 'unsafeMultiline',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not gate a visible herdr page on unreliable document focus', () => {
    vi.mocked(document.hasFocus).mockReturnValue(false)
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)

    render(<TerminalProvider><ContextCapture /></TerminalProvider>)

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.instances[0].url).toMatch(/\/ws\?mux=herdr&pane=w4%3Ap1$/)
  })

  it('stops automatic reconnect when another herdr controller takes over', () => {
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())

    act(() => ws.onclose?.({ reason: 'terminal attach taken over' }))

    expect(getContext().connectionState).toBe('disconnected')
    expect(getContext().takeoverDetected).toBe(true)
    expect(getContext().disconnectReason).toBe('terminal attach taken over')
    expect(getContext().reconnectAttempt).toBe(0)
  })

  it('coalesces rapid pane selections and connects only the latest target without reloading', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const initialSocket = MockWebSocket.instances[0]

    act(() => {
      for (let index = 1; index <= 100; index++) {
        getContext().switchTerminal('herdr', `w9:p${index}`)
      }
    })
    expect(MockWebSocket.instances).toHaveLength(1)

    act(() => { vi.advanceTimersByTime(70) })

    expect(initialSocket.close).toHaveBeenCalledOnce()
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(MockWebSocket.instances[1].url).toMatch(/\/ws\?mux=herdr&pane=w9%3Ap100$/)
    expect(getContext().mux).toBe('herdr')
    expect(getContext().paneId).toBe('w9:p100')
    expect(window.location.search).toBe('?mux=herdr&pane=w9%3Ap100')
  })

  it('keeps a herdr controller on window blur while the page remains visible', () => {
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())

    act(() => window.dispatchEvent(new Event('blur')))
    expect(ws.close).not.toHaveBeenCalled()
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(getContext().connectionState).toBe('connected')
    expect(getContext().reconnectAttempt).toBe(0)
  })

  it('keeps a tmux connection alive on window blur', () => {
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())

    act(() => window.dispatchEvent(new Event('blur')))

    expect(ws.close).not.toHaveBeenCalled()
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(getContext().connectionState).toBe('connected')
  })

  it('cancels a pending herdr reconnect when the page becomes hidden', () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('visible')
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())

    act(() => ws.onclose?.({ reason: '' }))
    expect(getContext().reconnectAttempt).toBe(1)
    visibility.mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    act(() => { vi.runAllTimers() })

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(getContext().reconnectAttempt).toBe(0)
  })

  it('reacquires the current herdr pane exactly once when the page becomes visible', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('visible')
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)

    act(() => {
      visibility.mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(MockWebSocket.instances).toHaveLength(1)

    act(() => {
      visibility.mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(MockWebSocket.instances).toHaveLength(2)
    expect(MockWebSocket.instances[1].url).toMatch(/\/ws\?mux=herdr&pane=w4%3Ap1$/)
  })

  it('defers pane changes while hidden and reacquires only the latest target', () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('visible')
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)

    visibility.mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    act(() => {
      getContext().switchTerminal('herdr', 'w4:p2')
      getContext().switchTerminal('herdr', 'w4:p3')
      vi.advanceTimersByTime(70)
    })

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(getContext().paneId).toBe('w4:p3')

    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))

    expect(MockWebSocket.instances).toHaveLength(2)
    expect(MockWebSocket.instances[1].url).toMatch(/\/ws\?mux=herdr&pane=w4%3Ap3$/)
  })

  it('sends one complete ttyd UTF-8 frame and reports its byte length', () => {
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())
    ws.send.mockClear()
    const text = 'START\n中文 😀\nEND'
    const payload = new TextEncoder().encode(text)

    expect(getContext().sendInput(text)).toEqual({ ok: true, byteLength: payload.byteLength })
    expect(ws.send).toHaveBeenCalledOnce()
    const frame = ws.send.mock.calls[0][0]
    const bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
    expect(bytes[0]).toBe(0x30)
    expect(Array.from(bytes.slice(1))).toEqual(Array.from(payload))
  })

  it('reports a synchronous WebSocket send error', () => {
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())
    ws.send.mockImplementationOnce(() => { throw new Error('socket failed') })

    expect(getContext().sendInput('keep me')).toEqual({ ok: false, reason: 'sendFailed' })
  })

  it('sends the CSI-u Shift+Enter sequence', () => {
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())
    ws.send.mockClear()

    getContext().sendKey('SHIFT_ENTER')

    expect(ws.send).toHaveBeenCalledOnce()
    const frame = ws.send.mock.calls[0][0]
    const bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
    expect(new TextDecoder().decode(bytes)).toBe(`0\x1b[13;2u`)
  })
})
