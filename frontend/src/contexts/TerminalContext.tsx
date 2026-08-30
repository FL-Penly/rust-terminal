import React, { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from 'react'

const encoder = new TextEncoder()
const MAX_EARLY_CHUNKS = 200

export type InputFailureReason = 'disconnected' | 'terminalUnavailable' | 'sendFailed' | 'unsafeMultiline'

export type InputSendResult =
  | { ok: true; byteLength: number }
  | { ok: false; reason: InputFailureReason }

export type PasteInputHandler = (text: string) => InputSendResult

export type TerminalMux = 'tmux' | 'herdr'

export interface TerminalContextValue {
  connectionState: 'connecting' | 'connected' | 'disconnected' | 'reconnecting'
  
  sendInput: (text: string) => InputSendResult

  pasteInput: (text: string) => InputSendResult

  registerPasteHandler: (handler: PasteInputHandler) => () => void
  
  sendKey: (key: 'ESC' | 'TAB' | 'SHIFT_TAB' | 'ENTER' | 'SHIFT_ENTER' | 'CTRL_C' | 'ARROW_UP' | 'ARROW_DOWN' | 'ARROW_LEFT' | 'ARROW_RIGHT' | 'PAGE_UP' | 'PAGE_DOWN' | 'CTRL_L') => void
  
  subscribeOutput: (callback: (data: string | Uint8Array) => void) => () => void
  
  sendControl: (byte: number) => void
  
  terminalRef: React.RefObject<HTMLDivElement>

  resize: (cols: number, rows: number) => void

  reconnect: () => void
  
  reconnectAttempt: number

  clientTty: string | null
  setClientTty: (tty: string) => void

  mux: TerminalMux

  paneId: string | null

  switchTerminal: (mux: TerminalMux, paneId?: string) => void

  disconnectReason: string | null

  takeoverDetected: boolean
}

const TerminalContext = createContext<TerminalContextValue | null>(null)

export const useTerminal = () => {
  const context = useContext(TerminalContext)
  if (!context) {
    throw new Error('useTerminal must be used within a TerminalProvider')
  }
  return context
}

const KEY_SEQUENCES: Record<string, string> = {
  'ESC': '\x1b',
  'TAB': '\t',
  'SHIFT_TAB': '\x1b[Z',
  'ENTER': '\r',
  'SHIFT_ENTER': '\x1b[13;2u',
  'CTRL_C': '\x03',
  'ARROW_UP': '\x1b[A',
  'ARROW_DOWN': '\x1b[B',
  'ARROW_RIGHT': '\x1b[C',
  'ARROW_LEFT': '\x1b[D',
  'PAGE_UP': '\x1b[5~',
  'PAGE_DOWN': '\x1b[6~',
  'CTRL_L': '\x0c',
}

const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_DELAYS = [500, 1000, 2000, 3000, 5000, 5000, 10000, 10000, 15000, 30000]

const TMUX_SESSION_KEY = 'ttyd_last_tmux_session'
const TARGET_SWITCH_DELAY = 70

interface TerminalTarget {
  mux: TerminalMux
  paneId: string | null
}

const readTerminalTarget = (): TerminalTarget => {
  const params = new URLSearchParams(window.location.search)
  const paneId = params.get('pane')
  return params.get('mux') === 'herdr' && paneId
    ? { mux: 'herdr', paneId }
    : { mux: 'tmux', paneId: null }
}

const sameTerminalTarget = (left: TerminalTarget, right: TerminalTarget) => (
  left.mux === right.mux && left.paneId === right.paneId
)

const pageOwnsHerdrFocus = () => (
  document.visibilityState === 'visible' && document.hasFocus()
)

export const TerminalProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [target, setTarget] = useState<TerminalTarget>(readTerminalTarget)
  const targetRef = useRef<TerminalTarget>(target)
  const terminalRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const pasteHandlerRef = useRef<PasteInputHandler | null>(null)
  const listenersRef = useRef<Set<(data: string | Uint8Array) => void>>(new Set())
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'disconnected' | 'reconnecting'>('connecting')
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const targetSwitchTimerRef = useRef<number | null>(null)
  const pendingTargetRef = useRef<TerminalTarget | null>(null)
  const connectionGenerationRef = useRef(0)
  const herdrOwnershipSuspendedRef = useRef(!pageOwnsHerdrFocus())
  const focusAbortRef = useRef<AbortController | null>(null)
  const lastConnectedTimeRef = useRef<number>(0)
  const [clientTty, setClientTty] = useState<string | null>(null)
  const [disconnectReason, setDisconnectReason] = useState<string | null>(null)
  const [takeoverDetected, setTakeoverDetected] = useState(false)
  const clientTtyRef = useRef<string | null>(null)
  
  const dimensionsRef = useRef({ cols: 80, rows: 24 })

  const earlyOutputRef = useRef<Uint8Array[]>([])
  const hasSubscribersRef = useRef(false)

  const writeBufferRef = useRef<Uint8Array[]>([])
  const writeTotalRef = useRef(0)
  const rafIdRef = useRef<number | null>(null)

  const flushBuffer = useCallback(() => {
    const chunks = writeBufferRef.current
    if (chunks.length === 0) return
    
    rafIdRef.current = null
    
    let combined: Uint8Array
    if (chunks.length === 1) {
      combined = chunks[0]
    } else {
      combined = new Uint8Array(writeTotalRef.current)
      let offset = 0
      for (const chunk of chunks) {
        combined.set(chunk, offset)
        offset += chunk.length
      }
    }
    
    writeBufferRef.current = []
    writeTotalRef.current = 0
    
    if (!hasSubscribersRef.current) {
      if (earlyOutputRef.current.length >= MAX_EARLY_CHUNKS) {
        earlyOutputRef.current.shift()
      }
      earlyOutputRef.current.push(combined)
      return
    }
    listenersRef.current.forEach(listener => listener(combined))
  }, [])

  const waitForClientTty = useCallback(async (timeoutMs = 3000): Promise<string | null> => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (clientTtyRef.current) return clientTtyRef.current
      await new Promise(r => setTimeout(r, 100))
    }
    return clientTtyRef.current
  }, [])

  const restoreTmuxSession = useCallback(async (_ws: WebSocket) => {
    const savedSession = sessionStorage.getItem(TMUX_SESSION_KEY)
    if (!savedSession) return

    console.log(`[Terminal] Restoring tmux session: ${savedSession}`)

     const tty = await waitForClientTty(3000)
     if (!tty) return

     for (let attempt = 0; attempt < 10; attempt++) {
       try {
         const listUrl = `/api/tmux/list?client_tty=${encodeURIComponent(tty)}`
         const listRes = await fetch(listUrl, { signal: AbortSignal.timeout(3000) })
         if (!listRes.ok) break
         const data = await listRes.json()
         const sessions: { name: string }[] = data.sessions || []

         if (!sessions.some(s => s.name === savedSession)) {
           console.log(`[Terminal] Saved session "${savedSession}" no longer exists`)
           sessionStorage.removeItem(TMUX_SESSION_KEY)
           return
         }

         if (data.currentSession) {
           if (data.currentSession === savedSession) {
             console.log(`[Terminal] Already on correct session: ${savedSession}`)
             return
           }
           const switchUrl = `/api/tmux/switch?session=${encodeURIComponent(savedSession)}&client_tty=${encodeURIComponent(tty)}`
          const switchRes = await fetch(switchUrl, { signal: AbortSignal.timeout(3000) })
          if (switchRes.ok) {
            console.log(`[Terminal] Restored tmux session via API: ${savedSession}`)
            return
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 500))
    }
  }, [waitForClientTty])

  const connectRef = useRef<(nextTarget: TerminalTarget, generation: number, reconnecting: boolean) => void>(() => undefined)

  const connect = useCallback((nextTarget: TerminalTarget, generation: number, reconnecting: boolean) => {
    if (generation !== connectionGenerationRef.current) return
    if (nextTarget.mux === 'herdr' && herdrOwnershipSuspendedRef.current) {
      setConnectionState('disconnected')
      return
    }
    const existing = wsRef.current
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return

    setConnectionState(reconnecting ? 'reconnecting' : 'connecting')

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const path = window.location.pathname.replace(/\/$/, '')
    const wsParams = nextTarget.mux === 'herdr'
      ? `?mux=herdr&pane=${encodeURIComponent(nextTarget.paneId ?? '')}`
      : ''
    const wsUrl = `${protocol}//${host}${path}/ws${wsParams}`

    const ws = new WebSocket(wsUrl, ['tty'])
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      if (generation !== connectionGenerationRef.current || wsRef.current !== ws) return
      console.log('[Terminal] WebSocket connected')
      setConnectionState('connected')
      setReconnectAttempt(0)
      setDisconnectReason(null)
      setTakeoverDetected(false)
      lastConnectedTimeRef.current = Date.now()
      clientTtyRef.current = null
      setClientTty(null)
      
      const { cols, rows } = dimensionsRef.current
      const auth = JSON.stringify({ AuthToken: '', columns: cols, rows: rows })
      ws.send(encoder.encode(auth))

      if (nextTarget.mux === 'tmux') {
        restoreTmuxSession(ws)
      }
    }

    ws.onmessage = (event) => {
      if (generation !== connectionGenerationRef.current || wsRef.current !== ws) return
      const data = new Uint8Array(event.data as ArrayBuffer)
      if (data.length === 0) return

      const cmd = String.fromCharCode(data[0])
      
      if (cmd === '0') {
        const payload = data.subarray(1)

        if (!clientTtyRef.current) {
          const text = new TextDecoder().decode(payload)
          const m = text.match(/\]7337;(\/dev\/[A-Za-z0-9/]+)/)
          if (m) {
            clientTtyRef.current = m[1]
            setClientTty(m[1])
          }
        }

        writeBufferRef.current.push(payload)
        writeTotalRef.current += payload.length
        
        const SAFETY_VALVE = 512 * 1024
        if (writeTotalRef.current > SAFETY_VALVE) {
          flushBuffer()
        } else if (rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(flushBuffer)
        }
      } else if (cmd === '1') {
        const title = new TextDecoder().decode(data.subarray(1))
        document.title = title
      }
    }

    ws.onclose = (event) => {
      if (generation !== connectionGenerationRef.current || wsRef.current !== ws) return
      console.log('[Terminal] WebSocket closed', event.reason)
      wsRef.current = null
      
      flushBuffer()
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      
      const wasTakenOver = nextTarget.mux === 'herdr' && event.reason.toLocaleLowerCase().includes('taken over')
      setDisconnectReason(event.reason || (nextTarget.mux === 'herdr' ? 'Herdr terminal connection closed' : 'Connection lost'))
      setTakeoverDetected(wasTakenOver)
      
      setConnectionState('disconnected')
      if (wasTakenOver) {
        setReconnectAttempt(0)
        return
      }
      if (nextTarget.mux === 'herdr' && herdrOwnershipSuspendedRef.current) {
        setReconnectAttempt(0)
        return
      }

      setReconnectAttempt(prev => {
        const attempt = prev + 1
        if (attempt <= MAX_RECONNECT_ATTEMPTS) {
          const delay = RECONNECT_DELAYS[prev] || 30000
          console.log(`[Terminal] Reconnecting in ${delay}ms (attempt ${attempt})`)
          reconnectTimerRef.current = window.setTimeout(() => {
            const ownershipSuspended = nextTarget.mux === 'herdr' && herdrOwnershipSuspendedRef.current
            if (generation === connectionGenerationRef.current && !ownershipSuspended) {
              connectRef.current(nextTarget, generation, true)
            }
          }, delay)
        }
        return attempt
      })
    }

    ws.onerror = (error) => {
      if (generation !== connectionGenerationRef.current || wsRef.current !== ws) return
      console.error('[Terminal] WebSocket error', error)
      if (nextTarget.mux === 'herdr') setDisconnectReason('Unable to reach the Herdr terminal controller')
    }
  }, [restoreTmuxSession, flushBuffer])

  connectRef.current = connect

  const retireConnection = useCallback((clearScreen: boolean) => {
    const generation = connectionGenerationRef.current + 1
    connectionGenerationRef.current = generation
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    const previous = wsRef.current
    wsRef.current = null
    if (previous) {
      previous.onopen = null
      previous.onmessage = null
      previous.onclose = null
      previous.onerror = null
      previous.close()
    }
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    writeBufferRef.current = []
    writeTotalRef.current = 0
    earlyOutputRef.current = []
    if (clearScreen) listenersRef.current.forEach(listener => listener('\x1bc'))
    clientTtyRef.current = null
    setClientTty(null)
    return generation
  }, [])

  const replaceConnection = useCallback((nextTarget: TerminalTarget, reconnecting: boolean) => {
    const generation = retireConnection(!reconnecting)
    setDisconnectReason(null)
    setTakeoverDetected(false)
    setReconnectAttempt(0)
    if (nextTarget.mux === 'herdr' && herdrOwnershipSuspendedRef.current) {
      setConnectionState('disconnected')
      return
    }
    connectRef.current(nextTarget, generation, reconnecting)
  }, [retireConnection])

  const suspendHerdrOwnership = useCallback(() => {
    const alreadySuspended = herdrOwnershipSuspendedRef.current
    herdrOwnershipSuspendedRef.current = true
    if (targetRef.current.mux !== 'herdr') return

    const previous = wsRef.current
    if (alreadySuspended && !previous && reconnectTimerRef.current === null) return

    retireConnection(false)
    setConnectionState('disconnected')
    setReconnectAttempt(0)
    setDisconnectReason(null)
    setTakeoverDetected(false)
  }, [retireConnection])

  const resumeHerdrOwnership = useCallback(() => {
    if (document.visibilityState !== 'visible') return
    herdrOwnershipSuspendedRef.current = false
    if (targetRef.current.mux !== 'herdr') return

    const ws = wsRef.current
    const isActive = ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
    if (!isActive) replaceConnection(targetRef.current, true)
  }, [replaceConnection])

  const switchTerminal = useCallback((mux: TerminalMux, paneId?: string) => {
    const nextTarget: TerminalTarget = mux === 'herdr' && paneId
      ? { mux: 'herdr', paneId }
      : { mux: 'tmux', paneId: null }
    if (targetSwitchTimerRef.current) {
      window.clearTimeout(targetSwitchTimerRef.current)
      targetSwitchTimerRef.current = null
    }
    pendingTargetRef.current = nextTarget
    if (sameTerminalTarget(targetRef.current, nextTarget)) {
      pendingTargetRef.current = null
      return
    }
    targetSwitchTimerRef.current = window.setTimeout(() => {
      const pendingTarget = pendingTargetRef.current
      if (!pendingTarget || !sameTerminalTarget(pendingTarget, nextTarget)) return
      pendingTargetRef.current = null
      targetSwitchTimerRef.current = null
      targetRef.current = nextTarget
      setTarget(nextTarget)

      const url = new URL(window.location.href)
      url.searchParams.delete('mux')
      url.searchParams.delete('pane')
      if (nextTarget.mux === 'herdr') {
        url.searchParams.set('mux', 'herdr')
        url.searchParams.set('pane', nextTarget.paneId ?? '')
      }
      window.history.replaceState(window.history.state, '', url)

      focusAbortRef.current?.abort()
      if (nextTarget.mux === 'herdr' && nextTarget.paneId) {
        const controller = new AbortController()
        focusAbortRef.current = controller
        void fetch(`/api/herdr/focus?pane=${encodeURIComponent(nextTarget.paneId)}`, { signal: controller.signal })
          .then(response => {
            if (!response.ok) console.warn('[Terminal] Herdr focus failed; terminal connection will continue')
          })
          .catch(error => {
            if (error instanceof DOMException && error.name === 'AbortError') return
            console.warn('[Terminal] Herdr focus failed; terminal connection will continue', error)
          })
      }
      replaceConnection(nextTarget, false)
    }, TARGET_SWITCH_DELAY)
  }, [replaceConnection])

  const reconnect = useCallback(() => {
    replaceConnection(targetRef.current, true)
  }, [replaceConnection])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        suspendHerdrOwnership()
        return
      }
      if (targetRef.current.mux === 'herdr') {
        if (document.hasFocus()) resumeHerdrOwnership()
        return
      }

      const ws = wsRef.current
      const isDisconnected = !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING

      if (isDisconnected) {
        console.log('[Terminal] Page became visible, connection lost — reconnecting immediately')
        replaceConnection(targetRef.current, true)
      } else if (ws.readyState === WebSocket.OPEN) {
        // Mobile browsers may freeze WebSocket without firing onclose; probe with a resize msg
        const timeSinceConnect = Date.now() - lastConnectedTimeRef.current
        if (timeSinceConnect > 30000) {
          const { cols, rows } = dimensionsRef.current
          const resizeMsg = JSON.stringify({ AuthToken: '', columns: cols, rows: rows })
          const payload = encoder.encode(resizeMsg)
          const buf = new Uint8Array(payload.length + 1)
          buf[0] = 0x31
          buf.set(payload, 1)
          try {
            ws.send(buf)
          } catch {
            console.log('[Terminal] Connection stale on visibility change — forcing reconnect')
            ws.close()
          }
        }
      }
    }

    const handleWindowBlur = () => suspendHerdrOwnership()
    const handleWindowFocus = () => resumeHerdrOwnership()

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('focus', handleWindowFocus)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('focus', handleWindowFocus)
    }
  }, [replaceConnection, resumeHerdrOwnership, suspendHerdrOwnership])

  useEffect(() => {
    replaceConnection(targetRef.current, false)
    return () => {
      connectionGenerationRef.current += 1
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current)
      }
      if (targetSwitchTimerRef.current) {
        window.clearTimeout(targetSwitchTimerRef.current)
      }
      focusAbortRef.current?.abort()
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      if (wsRef.current) {
        wsRef.current.onopen = null
        wsRef.current.onmessage = null
        wsRef.current.onclose = null
        wsRef.current.onerror = null
        wsRef.current.close()
      }
    }
  }, [replaceConnection])

  const sendInput = useCallback((text: string): InputSendResult => {
    const ws = wsRef.current
    if (pendingTargetRef.current || !ws || ws.readyState !== WebSocket.OPEN) {
      return { ok: false, reason: 'disconnected' }
    }

    const payload = encoder.encode(text)
    const buf = new Uint8Array(payload.length + 1)
    buf[0] = 0x30
    buf.set(payload, 1)
    try {
      ws.send(buf)
      return { ok: true, byteLength: payload.byteLength }
    } catch (err) {
      console.error('[Terminal] Failed to send input:', err)
      return { ok: false, reason: 'sendFailed' }
    }
  }, [])

  const pasteInput = useCallback((text: string): InputSendResult => {
    const handler = pasteHandlerRef.current
    if (!handler) return { ok: false, reason: 'terminalUnavailable' }
    return handler(text)
  }, [])

  const registerPasteHandler = useCallback((handler: PasteInputHandler) => {
    pasteHandlerRef.current = handler
    return () => {
      if (pasteHandlerRef.current === handler) pasteHandlerRef.current = null
    }
  }, [])

  const sendKey = useCallback((key: keyof typeof KEY_SEQUENCES) => {
    const sequence = KEY_SEQUENCES[key]
    if (sequence) {
      sendInput(sequence)
    }
  }, [sendInput])

  const subscribeOutput = useCallback((callback: (data: string | Uint8Array) => void) => {
    listenersRef.current.add(callback)
    if (!hasSubscribersRef.current) {
      hasSubscribersRef.current = true
      const buffered = earlyOutputRef.current
      earlyOutputRef.current = []
      for (const chunk of buffered) {
        callback(chunk)
      }
    }
    return () => {
      listenersRef.current.delete(callback)
    }
  }, [])

  const sendControl = useCallback((byte: number) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(new Uint8Array([byte]))
    }
  }, [])

  const setClientTtyValue = useCallback((tty: string) => {
    clientTtyRef.current = tty
    setClientTty(tty)
  }, [])

  const resize = useCallback((cols: number, rows: number) => {
    dimensionsRef.current = { cols, rows }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const resizeMsg = JSON.stringify({ AuthToken: '', columns: cols, rows: rows })
      const payload = encoder.encode(resizeMsg)
      const buf = new Uint8Array(payload.length + 1)
      buf[0] = 0x31
      buf.set(payload, 1)
      wsRef.current.send(buf)
    }
  }, [])

  const contextValue = useMemo(() => ({
    connectionState,
    sendInput,
    pasteInput,
    registerPasteHandler,
    sendKey,
    subscribeOutput,
    sendControl,
    terminalRef,
    resize,
    reconnect,
    reconnectAttempt,
    clientTty,
    setClientTty: setClientTtyValue,
    mux: target.mux,
    paneId: target.paneId,
    switchTerminal,
    disconnectReason,
    takeoverDetected,
  }), [connectionState, sendInput, pasteInput, registerPasteHandler, sendKey, subscribeOutput, sendControl, terminalRef, resize, reconnect, reconnectAttempt, clientTty, setClientTtyValue, target, switchTerminal, disconnectReason, takeoverDetected])

  return (
    <TerminalContext.Provider value={contextValue}>
      {children}
    </TerminalContext.Provider>
  )
}
