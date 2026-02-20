import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'

export interface TerminalContextValue {
  connectionState: 'connecting' | 'connected' | 'disconnected' | 'reconnecting'
  
  sendInput: (text: string) => void
  
  sendKey: (key: 'ESC' | 'TAB' | 'ENTER' | 'CTRL_C' | 'ARROW_UP' | 'ARROW_DOWN' | 'ARROW_LEFT' | 'ARROW_RIGHT' | 'PAGE_UP' | 'PAGE_DOWN' | 'CTRL_L') => void
  
  subscribeOutput: (callback: (data: string | Uint8Array) => void) => () => void
  
  sendControl: (byte: number) => void
  
  terminalRef: React.RefObject<HTMLDivElement>

  resize: (cols: number, rows: number) => void

  reconnect: () => void
  
  reconnectAttempt: number

  clientTty: string | null
  setClientTty: (tty: string) => void
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
  'ENTER': '\r',
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

export const TerminalProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const terminalRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const listenersRef = useRef<Set<(data: string | Uint8Array) => void>>(new Set())
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'disconnected' | 'reconnecting'>('connecting')
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const manualDisconnectRef = useRef(false)
  const isReconnectRef = useRef(false)
  const lastConnectedTimeRef = useRef<number>(0)
  const [clientTty, setClientTty] = useState<string | null>(null)
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

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return
    
    const wasReconnect = isReconnectRef.current
    setConnectionState(wasReconnect ? 'reconnecting' : 'connecting')
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const path = window.location.pathname.replace(/\/$/, '')
    const wsUrl = `${protocol}//${host}${path}/ws`

    const ws = new WebSocket(wsUrl, ['tty'])
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      console.log('[Terminal] WebSocket connected')
      setConnectionState('connected')
      setReconnectAttempt(0)
      lastConnectedTimeRef.current = Date.now()
      clientTtyRef.current = null
      setClientTty(null)
      
      const { cols, rows } = dimensionsRef.current
      const auth = JSON.stringify({ AuthToken: '', columns: cols, rows: rows })
      ws.send(new TextEncoder().encode(auth))

      if (wasReconnect) {
        isReconnectRef.current = false
        restoreTmuxSession(ws)
      }
    }

    ws.onmessage = (event) => {
      const data = new Uint8Array(event.data as ArrayBuffer)
      if (data.length === 0) return

      const cmd = String.fromCharCode(data[0])
      
      if (cmd === '0') {
        const payload = data.subarray(1)

        if (!clientTtyRef.current) {
          const text = new TextDecoder().decode(payload)
          const m = text.match(/\]7337;(\/dev\/pts\/\d+)/)
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

    ws.onclose = () => {
      console.log('[Terminal] WebSocket closed')
      wsRef.current = null
      
      flushBuffer()
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      
      if (manualDisconnectRef.current) {
        manualDisconnectRef.current = false
        setConnectionState('disconnected')
        return
      }
      
      setConnectionState('disconnected')
      isReconnectRef.current = true
      
      setReconnectAttempt(prev => {
        const attempt = prev + 1
        if (attempt <= MAX_RECONNECT_ATTEMPTS) {
          const delay = RECONNECT_DELAYS[prev] || 30000
          console.log(`[Terminal] Reconnecting in ${delay}ms (attempt ${attempt})`)
          reconnectTimerRef.current = window.setTimeout(() => {
            connect()
          }, delay)
        }
        return attempt
      })
    }

    ws.onerror = (error) => {
      console.error('[Terminal] WebSocket error', error)
    }
  }, [restoreTmuxSession, flushBuffer])

  const reconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    isReconnectRef.current = true
    setReconnectAttempt(0)
    connect()
  }, [connect])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const ws = wsRef.current
        const isDisconnected = !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING

        if (isDisconnected) {
          console.log('[Terminal] Page became visible, connection lost — reconnecting immediately')
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current)
            reconnectTimerRef.current = null
          }
          isReconnectRef.current = true
          setReconnectAttempt(0)
          connect()
        } else if (ws && ws.readyState === WebSocket.OPEN) {
          // Mobile browsers may freeze WebSocket without firing onclose; probe with a resize msg
          const timeSinceConnect = Date.now() - lastConnectedTimeRef.current
          if (timeSinceConnect > 30000) {
            const { cols, rows } = dimensionsRef.current
            const resizeMsg = JSON.stringify({ AuthToken: '', columns: cols, rows: rows })
            const payload = new TextEncoder().encode(resizeMsg)
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
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [connect])

  useEffect(() => {
    connect()
    return () => {
      manualDisconnectRef.current = true
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
      }
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [connect])

  const sendInput = useCallback((text: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const payload = new TextEncoder().encode(text)
      const buf = new Uint8Array(payload.length + 1)
      buf[0] = 0x30
      buf.set(payload, 1)
      wsRef.current.send(buf)
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
      const payload = new TextEncoder().encode(resizeMsg)
      const buf = new Uint8Array(payload.length + 1)
      buf[0] = 0x31
      buf.set(payload, 1)
      wsRef.current.send(buf)
    }
  }, [])

  return (
    <TerminalContext.Provider value={{
      connectionState,
      sendInput,
      sendKey,
      subscribeOutput,
      sendControl,
      terminalRef,
      resize,
      reconnect,
      reconnectAttempt,
      clientTty,
      setClientTty: setClientTtyValue,
    }}>
      {children}
    </TerminalContext.Provider>
  )
}
