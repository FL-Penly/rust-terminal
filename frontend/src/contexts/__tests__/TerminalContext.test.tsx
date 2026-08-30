import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  TerminalProvider,
  useTerminal,
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

  it('defers the initial herdr connection until a background page receives focus', () => {
    vi.mocked(document.hasFocus).mockReturnValue(false)
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)

    render(<TerminalProvider><ContextCapture /></TerminalProvider>)

    expect(MockWebSocket.instances).toHaveLength(0)
    expect(getContext().connectionState).toBe('disconnected')

    act(() => window.dispatchEvent(new Event('focus')))

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

  it('releases a herdr controller on window blur without reconnecting in the background', () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())

    act(() => window.dispatchEvent(new Event('blur')))
    act(() => { vi.runAllTimers() })

    expect(ws.close).toHaveBeenCalledOnce()
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(getContext().connectionState).toBe('disconnected')
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

  it('cancels a pending herdr reconnect when focus is lost', () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())

    act(() => ws.onclose?.({ reason: '' }))
    expect(getContext().reconnectAttempt).toBe(1)
    act(() => window.dispatchEvent(new Event('blur')))
    act(() => { vi.runAllTimers() })

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(getContext().reconnectAttempt).toBe(0)
  })

  it('reacquires the current herdr pane exactly once when window focus returns', () => {
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)

    act(() => {
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('blur'))
    })
    expect(MockWebSocket.instances).toHaveLength(1)

    act(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('focus'))
    })

    expect(MockWebSocket.instances).toHaveLength(2)
    expect(MockWebSocket.instances[1].url).toMatch(/\/ws\?mux=herdr&pane=w4%3Ap1$/)
  })

  it('defers pane changes while unfocused and reacquires only the latest target', () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)

    act(() => window.dispatchEvent(new Event('blur')))
    act(() => {
      getContext().switchTerminal('herdr', 'w4:p2')
      getContext().switchTerminal('herdr', 'w4:p3')
      vi.advanceTimersByTime(70)
    })

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(getContext().paneId).toBe('w4:p3')

    act(() => window.dispatchEvent(new Event('focus')))

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
