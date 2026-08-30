import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { Unicode11Addon } from '@xterm/addon-unicode11'

import '@xterm/xterm/css/xterm.css'
import { useTerminal } from '../contexts/TerminalContext'
import { useServerEvents } from '../contexts/ServerEventsContext'
import { ZerolagInputAddon } from 'xterm-zerolag-input'
import { CopyModeOverlay } from './CopyModeOverlay'
import { AltScreenTranscript } from '../utils/alt-screen-transcript'
import { createTerminalPasteHandler, type PasteResultCapture } from '../utils/terminal-paste'
import { observeTerminalResize } from '../utils/terminal-resize'

const MIN_FONT_SIZE = 6
const MAX_FONT_SIZE = 24
const DEFAULT_FONT_SIZE = 12

export const Terminal = () => {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const { subscribeOutput, sendInput, registerPasteHandler, sendControl, resize, setClientTty, mux, paneId } = useTerminal()
  const { tuiActive } = useServerEvents()
  const setClientTtyRef = useRef(setClientTty)
  
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem('terminal_font_size')
    return saved ? parseInt(saved, 10) : DEFAULT_FONT_SIZE
  })
  const pinchRef = useRef({ initialDistance: 0, initialFontSize: DEFAULT_FONT_SIZE })
  const fontSizeRef = useRef(fontSize)
  const touchRef = useRef({ lastY: 0, accumDelta: 0, mode: 'none' as 'none' | 'scroll' | 'pinch' })
  const resizeTimerRef = useRef<number | null>(null)
  const [showZoom, setShowZoom] = useState(false)
  const zoomTimerRef = useRef<number | null>(null)
  const zerolagRef = useRef<ZerolagInputAddon | null>(null)
  const zerolagEnabledRef = useRef(localStorage.getItem('terminal_predictive_echo') !== 'off')
  const sendInputRef = useRef(sendInput)
  const pasteResultCaptureRef = useRef<PasteResultCapture['current']>(null)
  const mouseStateRef = useRef({ mouseTracking: false, sgrMode: false })
  const muxRef = useRef(mux)
  const wheelAccumRef = useRef(0)
  const selectionPolicyRef = useRef<'local' | 'pty'>('local')
  const clientTtyValueRef = useRef<string | null>(null)
  const [copyModeData, setCopyModeData] = useState<{ lines: string[]; viewportLine: number } | null>(null)
  const xtermScreenRef = useRef<HTMLElement | null>(null)
  const pinchWriteTimerRef = useRef<number | null>(null)
  const pinchResizeTimerRef = useRef<number | null>(null)
  const xtermTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const tapRef = useRef({ startX: 0, startY: 0, startTime: 0 })
  const lastTapTimeRef = useRef(0)

  useEffect(() => { sendInputRef.current = sendInput }, [sendInput])
  useEffect(() => { muxRef.current = mux }, [mux])
  useEffect(() => { selectionPolicyRef.current = tuiActive ? 'pty' : 'local' }, [tuiActive])

  const sendTerminalWheel = useCallback((direction: 'up' | 'down', clientX: number, clientY: number) => {
    const term = termRef.current
    const screen = xtermScreenRef.current
    if (!term || !screen) return
    const rect = screen.getBoundingClientRect()
    const col = Math.max(1, Math.min(term.cols, Math.floor((clientX - rect.left) / (rect.width / term.cols)) + 1))
    const row = Math.max(1, Math.min(term.rows, Math.floor((clientY - rect.top) / (rect.height / term.rows)) + 1))
    const button = direction === 'down' ? 65 : 64
    if (muxRef.current === 'herdr' || mouseStateRef.current.sgrMode) {
      sendInputRef.current(`\x1b[<${button};${col};${row}M`)
    } else {
      sendInputRef.current(`\x1b[M${String.fromCharCode(button + 32)}${String.fromCharCode(col + 32)}${String.fromCharCode(row + 32)}`)
    }
  }, [])

  const handleResize = useCallback(() => {
    if (fitAddonRef.current && termRef.current) {
      fitAddonRef.current.fit()
      const { cols, rows } = termRef.current
      resize(cols, rows)
    }
  }, [resize])

  const debouncedResize = useCallback(() => {
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
    resizeTimerRef.current = window.setTimeout(handleResize, 60)
  }, [handleResize])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    return observeTerminalResize(container, debouncedResize)
  }, [debouncedResize])

  const updateFontSize = useCallback((newSize: number) => {
    const clampedSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(newSize)))
    if (termRef.current && clampedSize !== termRef.current.options.fontSize) {
      termRef.current.options.fontSize = clampedSize
      setFontSize(clampedSize)
      fontSizeRef.current = clampedSize
      
      // Debounce localStorage write — only persist after 500ms idle
      if (pinchWriteTimerRef.current) clearTimeout(pinchWriteTimerRef.current)
      pinchWriteTimerRef.current = window.setTimeout(() => {
        localStorage.setItem('terminal_font_size', String(clampedSize))
      }, 500)
      
      // Throttle resize — at most every 100ms during pinch
      if (!pinchResizeTimerRef.current) {
        handleResize()
        pinchResizeTimerRef.current = window.setTimeout(() => {
          pinchResizeTimerRef.current = null
        }, 100)
      }
      
      setShowZoom(true)
      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current)
      zoomTimerRef.current = window.setTimeout(() => setShowZoom(false), 1200)
    }
  }, [handleResize])

  const getTouchDistance = (touches: TouchList) => {
    if (touches.length < 2) return 0
    const dx = touches[0].clientX - touches[1].clientX
    const dy = touches[0].clientY - touches[1].clientY
    return Math.sqrt(dx * dx + dy * dy)
  }

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (e.touches.length === 2) {
      touchRef.current.mode = 'pinch'
      pinchRef.current = {
        initialDistance: getTouchDistance(e.touches),
        initialFontSize: fontSizeRef.current
      }
    } else if (e.touches.length === 1) {
      touchRef.current = { lastY: e.touches[0].clientY, accumDelta: 0, mode: 'scroll' }
      tapRef.current = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, startTime: Date.now() }
    }
  }, [])

  const handleTouchMove = useCallback((e: TouchEvent) => {
    const t = touchRef.current
    if (e.touches.length === 2) {
      t.mode = 'pinch'
      const currentDistance = getTouchDistance(e.touches)
      const { initialDistance, initialFontSize } = pinchRef.current
      if (initialDistance > 0) {
        const scale = currentDistance / initialDistance
        updateFontSize(initialFontSize * scale)
      }
      e.preventDefault()
    } else if (e.touches.length === 1 && t.mode === 'scroll') {
      const term = termRef.current
      if (!term) return

      const isAltBuffer = term.buffer.active.type === 'alternate'
      const ms = mouseStateRef.current

      // Forward TUI scrolling explicitly. Herdr full frames omit DEC mouse-mode setup,
      // so xterm cannot infer wheel reporting from the frame by itself.
      if ((isAltBuffer && ms.mouseTracking) || (muxRef.current === 'herdr' && selectionPolicyRef.current === 'pty')) {
        const y = e.touches[0].clientY
        const delta = t.lastY - y
        t.lastY = y
        t.accumDelta += delta

       const screenEl = xtermScreenRef.current
         if (!screenEl) return

        const rect = screenEl.getBoundingClientRect()
        const cellHeight = rect.height / term.rows
        const stepPx = cellHeight * 0.8

        while (Math.abs(t.accumDelta) >= stepPx) {
          const dir = t.accumDelta > 0 ? 1 : -1
          t.accumDelta -= dir * stepPx

          sendTerminalWheel(dir > 0 ? 'down' : 'up', e.touches[0].clientX, e.touches[0].clientY)
        }
        e.preventDefault()
      }
      // Shell panes still use xterm's native scrollback and selection.
    }
  }, [sendTerminalWheel, updateFontSize])

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    const prevMode = touchRef.current.mode
    touchRef.current.mode = 'none'

    // Double-tap to show keyboard: detect two clean taps within 350ms
    if (prevMode === 'scroll' && e.changedTouches.length === 1) {
      const tap = tapRef.current
      const touch = e.changedTouches[0]
      const dx = Math.abs(touch.clientX - tap.startX)
      const dy = Math.abs(touch.clientY - tap.startY)
      const dt = Date.now() - tap.startTime

      // Clean tap: < 10px movement, < 500ms duration
      if (dx < 10 && dy < 10 && dt < 500) {
        const now = Date.now()
        if (now - lastTapTimeRef.current < 500) {
          lastTapTimeRef.current = 0
          const textarea = xtermTextareaRef.current
          if (textarea) {
            const isOpen = !textarea.getAttribute('inputmode')
            if (isOpen) {
              textarea.setAttribute('inputmode', 'none')
              textarea.blur()
            } else {
              textarea.removeAttribute('inputmode')
              textarea.blur()
              textarea.focus({ preventScroll: true })
            }
          }
        } else {
          // First tap — record time
          lastTapTimeRef.current = now
        }
      }
    }
  }, [])

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      fontSize: fontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: 'rgba(163, 113, 247, 0.5)',
        black: '#484f58',
        red: '#f85149',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#a371f7',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
      },
      scrollback: 5000,
      cursorBlink: true,

      allowProposedApi: true,
      rescaleOverlappingGlyphs: true,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      smoothScrollDuration: 0,
      fastScrollSensitivity: 5,

    })
    termRef.current = term

    const zerolag = new ZerolagInputAddon({
      prompt: { type: 'regex', pattern: /[>$%❯➜]\s*$/, offset: 2 },
    })
    term.loadAddon(zerolag)
    zerolagRef.current = zerolag

    // Load FitAddon
    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    term.loadAddon(fitAddon)

    const unicode11Addon = new Unicode11Addon()
    term.loadAddon(unicode11Addon)
    term.unicode.activeVersion = '11'
    let renderer: 'webgl' | 'dom' = 'dom'
    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        console.warn('[Terminal] WebGL context lost, falling back to DOM')
        webglAddon.dispose()
      })
      term.loadAddon(webglAddon)
      renderer = 'webgl'
    } catch {
      renderer = 'dom'
    }

    term.loadAddon(new ClipboardAddon())
    console.log(`[Terminal] Using ${renderer} renderer`)

    // Open terminal in container
    term.open(containerRef.current)

    // Mobile keyboard management: lock virtual keyboard by default on touch devices
    const xtermTextarea = containerRef.current.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
    xtermTextareaRef.current = xtermTextarea
    const isMobileDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0)
    if (isMobileDevice && xtermTextarea) {
      xtermTextarea.setAttribute('inputmode', 'none')
    }

    const xtermScreen = containerRef.current.querySelector('.xterm-screen') as HTMLElement | null
    xtermScreenRef.current = xtermScreen

    let pendingMouseDown: MouseEvent | null = null
    let isDragging = false
    const DRAG_THRESHOLD = 4
    const patchedMouseEvents = new WeakSet<Event>()
    const isMac = /mac/i.test(navigator.platform) || /macintosh/i.test(navigator.userAgent)
    const forceSelectModifier: MouseEventInit = isMac ? { altKey: true } : { shiftKey: true }

    const cloneMouseEvent = (e: MouseEvent, overrides: Partial<MouseEventInit> = {}): MouseEvent => {
      const init: MouseEventInit = {
        bubbles: true, cancelable: true, view: e.view, detail: e.detail,
        screenX: e.screenX, screenY: e.screenY, clientX: e.clientX, clientY: e.clientY,
        button: e.button, buttons: e.buttons, relatedTarget: e.relatedTarget,
        shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
        ...overrides,
      }
      const clone = new MouseEvent(e.type, init)
      patchedMouseEvents.add(clone)
      return clone
    }

    const sendSyntheticMouseToPty = (e: MouseEvent, type: 'down' | 'move' | 'up') => {
      if (!xtermScreen) return
      const rect = xtermScreen.getBoundingClientRect()
      const col = Math.max(1, Math.min(term.cols, Math.floor((e.clientX - rect.left) / (rect.width / term.cols)) + 1))
      const row = Math.max(1, Math.min(term.rows, Math.floor((e.clientY - rect.top) / (rect.height / term.rows)) + 1))
      const btn = type === 'move' ? 32 : 0
      if (mouseStateRef.current.sgrMode) {
        sendInputRef.current(`\x1b[<${btn};${col};${row}${type === 'up' ? 'm' : 'M'}`)
      } else if (col <= 223 && row <= 223) {
        sendInputRef.current(`\x1b[M${String.fromCharCode(32 + btn)}${String.fromCharCode(32 + col)}${String.fromCharCode(32 + row)}`)
      }
    }

    let currentDragMode: 'local' | 'pty' = 'local'

    const onMouseDownCapture = (e: MouseEvent) => {
      if (patchedMouseEvents.has(e) || !mouseStateRef.current.mouseTracking || e.button !== 0) return
      if (isMac ? e.altKey : e.shiftKey) return
      e.stopImmediatePropagation()
      e.preventDefault()
      pendingMouseDown = e
      isDragging = false
    }

    const onMouseMoveCapture = (e: MouseEvent) => {
      if (!pendingMouseDown || patchedMouseEvents.has(e)) return
      e.stopImmediatePropagation()
      e.preventDefault()
      if (!isDragging) {
        const dx = e.clientX - pendingMouseDown.clientX
        const dy = e.clientY - pendingMouseDown.clientY
        if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return
        isDragging = true
        currentDragMode = selectionPolicyRef.current
        if (currentDragMode === 'local') {
          pendingMouseDown.target?.dispatchEvent(cloneMouseEvent(pendingMouseDown, forceSelectModifier))
        } else {
          sendSyntheticMouseToPty(pendingMouseDown, 'down')
        }
      }
      if (currentDragMode === 'local') {
        const moveClone = new MouseEvent('mousemove', {
          bubbles: true, cancelable: true, view: e.view,
          screenX: e.screenX, screenY: e.screenY, clientX: e.clientX, clientY: e.clientY,
          button: e.button, buttons: e.buttons,
          ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, shiftKey: e.shiftKey,
          ...forceSelectModifier,
        })
        patchedMouseEvents.add(moveClone)
        e.target?.dispatchEvent(moveClone)
      } else {
        sendSyntheticMouseToPty(e, 'move')
      }
    }

    const onMouseUpCapture = (e: MouseEvent) => {
      if (!pendingMouseDown || patchedMouseEvents.has(e)) return
      e.stopImmediatePropagation()
      e.preventDefault()
      if (isDragging) {
        if (currentDragMode === 'local') {
          e.target?.dispatchEvent(cloneMouseEvent(e, forceSelectModifier))
        } else {
          sendSyntheticMouseToPty(e, 'up')
        }
      } else {
        pendingMouseDown.target?.dispatchEvent(cloneMouseEvent(pendingMouseDown))
        e.target?.dispatchEvent(cloneMouseEvent(e))
      }
      pendingMouseDown = null
      isDragging = false
    }

    if (xtermScreen) {
      xtermScreen.addEventListener('mousedown', onMouseDownCapture, { capture: true })
      xtermScreen.addEventListener('mousemove', onMouseMoveCapture, { capture: true })
      xtermScreen.addEventListener('mouseup', onMouseUpCapture, { capture: true })
    }

    const oscDisposable = term.parser.registerOscHandler(7337, (data) => {
      if (data) {
        clientTtyValueRef.current = data
        setClientTtyRef.current(data)
      }
      return false
    })

    // Track mouse mode: DECSET ?1000/1002/1003 h (enable) / l (disable)
    const csiDecsetDisposable = term.parser.registerCsiHandler(
      { prefix: '?', final: 'h' },
      (params) => {
        for (let i = 0; i < params.length; i++) {
          const p = params[i]
          if (typeof p === 'number') {
            if (p === 1000 || p === 1002 || p === 1003) {
              mouseStateRef.current.mouseTracking = true
            }
            if (p === 1006) mouseStateRef.current.sgrMode = true
            if (p === 1049 || p === 47) {
              zerolagRef.current?.clear()
              xtermTextareaRef.current?.blur()
            }
          }
        }
        return false
      }
    )
    const csiDecrstDisposable = term.parser.registerCsiHandler(
      { prefix: '?', final: 'l' },
      (params) => {
        for (let i = 0; i < params.length; i++) {
          const p = params[i]
          if (typeof p === 'number') {
            if (p === 1000 || p === 1002 || p === 1003) {
              mouseStateRef.current.mouseTracking = false
            }
            if (p === 1006) mouseStateRef.current.sgrMode = false
            if (p === 1049 || p === 47) zerolagRef.current?.clear()
          }
        }
        return false
      }
    )

    // Initial fit
    const initialFitTimer = setTimeout(() => {
      fitAddon.fit()
      const { cols, rows } = term
      resize(cols, rows)
    }, 0)

    // Handle user input -> send to WebSocket
    const dataDisposable = term.onData((data) => {
      let result
      if (!zerolagEnabledRef.current) {
        result = sendInput(data)
      } else if (data === '\r' || data === '\n') {
        zerolag.clear()
        result = sendInput(data)
      } else if (data === '\x7f' || data === '\b') {
        zerolag.removeChar()
        result = sendInput(data)
      } else if (data.length === 1 && data.charCodeAt(0) >= 0x20) {
        zerolag.addChar(data)
        result = sendInput(data)
      } else {
        zerolag.clear()
        result = sendInput(data)
      }
      pasteResultCaptureRef.current?.(result)
    })
    const unregisterPasteHandler = registerPasteHandler(
      createTerminalPasteHandler(term, pasteResultCaptureRef),
    )
    const altTranscript = new AltScreenTranscript()
    const readLine = (row: number): string => {
      const line = term.buffer.active.getLine(row)
      return line ? line.translateToString(true) : ''
    }

    if (term.buffer.active.type === 'alternate') altTranscript.onEnterAltBuffer()

    const bufferChangeDisposable = term.buffer.onBufferChange((buf) => {
      if (buf.type === 'alternate') altTranscript.onEnterAltBuffer()
      else altTranscript.onLeaveAltBuffer()
    })

    const writeParsedDisposable = term.onWriteParsed(() => {
      if (zerolag.hasPending) zerolag.rerender()
      altTranscript.scheduleCaptureFrame(term.rows, readLine)
    })

    term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      if (ev.type === 'keydown' && ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        ev.preventDefault()
        sendInput('\x1b[13;2u')
        return false
      }
      return true
    })

    const kittyQueryDisposable = term.parser.registerCsiHandler({ prefix: '?', final: 'u' }, () => {
      sendInput('\x1b[?0u')
      return true
    })
    const kittyPushDisposable = term.parser.registerCsiHandler({ prefix: '>', final: 'u' }, () => {
      return true
    })
    const kittyPopDisposable = term.parser.registerCsiHandler({ prefix: '<', final: 'u' }, () => {
      return true
    })

    const HIGH_WATER_BYTES = 256 * 1024
    let pendingBytes = 0
    let paused = false

    const unsubscribe = subscribeOutput((data) => {
      const size = typeof data === 'string' ? data.length : data.byteLength
      pendingBytes += size
      if (pendingBytes >= HIGH_WATER_BYTES && !paused) {
        paused = true
        sendControl(0x32)
      }
      term.write(data, () => {
        pendingBytes -= size
        if (pendingBytes <= 0 && paused) {
          pendingBytes = 0
          paused = false
          sendControl(0x33)
        }
      })
    })

    const handlePredictiveEchoChanged = (e: Event) => {
      const enabled = (e as CustomEvent).detail as boolean
      zerolagEnabledRef.current = enabled
      if (!enabled) zerolag.clear()
    }
    window.addEventListener('predictive-echo-changed', handlePredictiveEchoChanged)

    window.addEventListener('resize', debouncedResize)

    const vv = window.visualViewport
    vv?.addEventListener('resize', debouncedResize)
    
    const container = containerRef.current
    container.addEventListener('touchstart', handleTouchStart, { passive: true })
    container.addEventListener('touchmove', handleTouchMove, { passive: false })
    container.addEventListener('touchend', handleTouchEnd, { passive: true })

    const handleWheel = (event: WheelEvent) => {
      if (muxRef.current !== 'herdr' || selectionPolicyRef.current !== 'pty' || !xtermScreen) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const rect = xtermScreen.getBoundingClientRect()
      const cellHeight = rect.height / Math.max(1, term.rows)
      const normalizedDelta = event.deltaY * (event.deltaMode === 1 ? cellHeight : event.deltaMode === 2 ? rect.height : 1)
      wheelAccumRef.current += normalizedDelta
      const step = Math.max(8, cellHeight * 0.8)
      let emitted = 0
      while (Math.abs(wheelAccumRef.current) >= step && emitted < 8) {
        const direction = wheelAccumRef.current > 0 ? 'down' : 'up'
        wheelAccumRef.current += direction === 'down' ? -step : step
        sendTerminalWheel(direction, event.clientX, event.clientY)
        emitted += 1
      }
    }
    container.addEventListener('wheel', handleWheel, { passive: false, capture: true })

    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return

      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          e.preventDefault()
          const blob = item.getAsFile()
          if (!blob) return

          try {
            const response = await fetch(`/api/upload`, {
              method: 'POST',
              headers: {
                'Content-Type': blob.type || 'application/octet-stream',
                'X-Filename': encodeURIComponent(blob.name),
              },
              body: blob,
              signal: AbortSignal.timeout(30000),
            })
            if (!response.ok) throw new Error(`Upload failed: ${response.status}`)
            const { path } = await response.json()
            sendInput(path)
          } catch (err) {
            console.error('[Terminal] File upload failed:', err)
          }
          return
        }
      }
    }
    container.addEventListener('paste', handlePaste, true)

    const handleCopyViewport = () => {
      try {
        const isAlt = term.buffer.active.type === 'alternate'

        let lines: string[]
        let viewportLine: number

        if (isAlt && altTranscript.isActive() && altTranscript.getLines().length > term.rows) {
          const tLines = altTranscript.getLines()
          lines = [...tLines]
          viewportLine = Math.max(0, lines.length - term.rows)
        } else {
          const buf = isAlt ? term.buffer.active : term.buffer.normal
          lines = []
          for (let i = 0; i < buf.length; i++) {
            const line = buf.getLine(i)
            if (line) lines.push(line.translateToString(true))
          }
          viewportLine = isAlt ? 0 : buf.viewportY
        }

        while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
        if (lines.length === 0) return

        setCopyModeData(prev => prev ?? { lines, viewportLine })
      } catch (err) {
        console.error('[Sel] failed:', err)
      }
    }
    window.addEventListener('terminal-copy-viewport', handleCopyViewport)

    return () => {
      unsubscribe()
      unregisterPasteHandler()
      dataDisposable.dispose()
      writeParsedDisposable.dispose()
      oscDisposable.dispose()
      csiDecsetDisposable.dispose()
      csiDecrstDisposable.dispose()
      kittyQueryDisposable.dispose()
      kittyPushDisposable.dispose()
      kittyPopDisposable.dispose()
      bufferChangeDisposable.dispose()
      altTranscript.dispose()

      window.removeEventListener('predictive-echo-changed', handlePredictiveEchoChanged)
      window.removeEventListener('resize', debouncedResize)
      vv?.removeEventListener('resize', debouncedResize)
      window.removeEventListener('terminal-copy-viewport', handleCopyViewport)
      if (xtermScreen) {
        xtermScreen.removeEventListener('mousedown', onMouseDownCapture, { capture: true })
        xtermScreen.removeEventListener('mousemove', onMouseMoveCapture, { capture: true })
        xtermScreen.removeEventListener('mouseup', onMouseUpCapture, { capture: true })
      }
      clearTimeout(initialFitTimer)
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      if (pinchWriteTimerRef.current) clearTimeout(pinchWriteTimerRef.current)
      if (pinchResizeTimerRef.current) clearTimeout(pinchResizeTimerRef.current)
      container.removeEventListener('touchstart', handleTouchStart)
      container.removeEventListener('touchmove', handleTouchMove)
      container.removeEventListener('touchend', handleTouchEnd)
      container.removeEventListener('wheel', handleWheel, { capture: true })
      container.removeEventListener('paste', handlePaste, true)
      term.dispose()
    }
  }, [subscribeOutput, sendInput, registerPasteHandler, sendControl, resize, handleResize, debouncedResize, handleTouchStart, handleTouchMove, handleTouchEnd, sendTerminalWheel])

  const zoomPercent = Math.round((fontSize / DEFAULT_FONT_SIZE) * 100)

  return (
    <div className="relative w-full h-full">
      <div 
        ref={containerRef} 
        className="w-full h-full bg-bg-primary overflow-hidden"
        style={{ padding: '4px' }}
      />
      {showZoom && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg bg-black/70 backdrop-blur-sm border border-border-subtle text-text-primary text-sm font-mono pointer-events-none select-none z-10">
          {zoomPercent}% · {fontSize}px
        </div>
      )}
      {copyModeData && (
        <CopyModeOverlay
          lines={copyModeData.lines}
          initialScrollLine={copyModeData.viewportLine}
          onClose={() => setCopyModeData(null)}
          onFetchMore={async (page: number) => {
            try {
              const url = mux === 'herdr'
                ? `/api/herdr/page-up?pane=${encodeURIComponent(paneId ?? '')}&page=${page}`
                : `/api/tmux/page-up?page=${page}`
              const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
              if (!res.ok) return null
              const data = await res.json() as { lines: string[] }
              return data.lines.length > 0 ? data.lines : null
            } catch { return null }
          }}
        />
      )}
    </div>
  )
}
