import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { CanvasAddon } from '@xterm/addon-canvas'
import '@xterm/xterm/css/xterm.css'
import { useTerminal } from '../contexts/TerminalContext'
import { PredictiveEcho } from '../utils/predictive-echo'

const MIN_FONT_SIZE = 6
const MAX_FONT_SIZE = 24
const DEFAULT_FONT_SIZE = 12

const fallbackCopy = (text: string): boolean => {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch {}
  document.body.removeChild(textarea)
  return ok
}

export const Terminal = () => {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const { subscribeOutput, sendInput, sendControl, resize, setClientTty } = useTerminal()
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
  const predictiveEchoRef = useRef<PredictiveEcho | null>(null)
  const sendInputRef = useRef(sendInput)
  const mouseStateRef = useRef({ mouseTracking: false, sgrMode: false })
  const [showCopied, setShowCopied] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  const xtermScreenRef = useRef<HTMLElement | null>(null)
  const pinchWriteTimerRef = useRef<number | null>(null)
  const pinchResizeTimerRef = useRef<number | null>(null)

  useEffect(() => { sendInputRef.current = sendInput }, [sendInput])

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

      // Only intercept touch for alt-buffer mouse-tracking (tmux scroll)
      if (isAltBuffer && ms.mouseTracking) {
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

          const cellWidth = rect.width / term.cols
          const col = Math.max(1, Math.min(term.cols, Math.floor((e.touches[0].clientX - rect.left) / cellWidth) + 1))
          const row = Math.max(1, Math.min(term.rows, Math.floor((e.touches[0].clientY - rect.top) / cellHeight) + 1))
          const btn = dir > 0 ? 65 : 64

          if (ms.sgrMode) {
            sendInputRef.current(`\x1b[<${btn};${col};${row}M`)
          } else {
            sendInputRef.current(`\x1b[M${String.fromCharCode(btn + 32)}${String.fromCharCode(col + 32)}${String.fromCharCode(row + 32)}`)
          }
        }
        e.preventDefault()
      }
      // For normal buffer: do nothing — let xterm.js handle scroll + selection natively
    }
  }, [updateFontSize])

  const handleTouchEnd = useCallback(() => {
    touchRef.current.mode = 'none'
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
        selectionBackground: 'rgba(163, 113, 247, 0.3)',
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
      macOptionClickForcesSelection: true,
    })
    termRef.current = term

    const predictiveEcho = new PredictiveEcho(term)
    predictiveEcho.enabled = localStorage.getItem('terminal_predictive_echo') !== 'off'
    predictiveEchoRef.current = predictiveEcho

    // Load FitAddon
    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    term.loadAddon(fitAddon)

    let renderer: 'webgl' | 'canvas' | 'dom' = 'dom'
    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        console.warn('[Terminal] WebGL context lost, falling back to canvas')
        webglAddon.dispose()
        try {
          term.loadAddon(new CanvasAddon())
        } catch {}
      })
      term.loadAddon(webglAddon)
      renderer = 'webgl'
    } catch (e) {
      try {
        term.loadAddon(new CanvasAddon())
        renderer = 'canvas'
      } catch (e2) {
        renderer = 'dom'
      }
    }
    console.log(`[Terminal] Using ${renderer} renderer`)

    // Open terminal in container
    term.open(containerRef.current)

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

    const onMouseDownCapture = (e: MouseEvent) => {
      if (patchedMouseEvents.has(e) || !mouseStateRef.current.mouseTracking || e.button !== 0) return
      if (isMac ? (e.altKey) : (e.shiftKey)) return
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
        pendingMouseDown.target?.dispatchEvent(cloneMouseEvent(pendingMouseDown, forceSelectModifier))
      }
      const moveClone = new MouseEvent('mousemove', {
        bubbles: true, cancelable: true, view: e.view,
        screenX: e.screenX, screenY: e.screenY, clientX: e.clientX, clientY: e.clientY,
        button: e.button, buttons: e.buttons,
        ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, shiftKey: e.shiftKey,
        ...forceSelectModifier,
      })
      patchedMouseEvents.add(moveClone)
      e.target?.dispatchEvent(moveClone)
    }

    const onMouseUpCapture = (e: MouseEvent) => {
      if (!pendingMouseDown || patchedMouseEvents.has(e)) return
      e.stopImmediatePropagation()
      e.preventDefault()
      if (isDragging) {
        e.target?.dispatchEvent(cloneMouseEvent(e, forceSelectModifier))
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
      if (data) setClientTtyRef.current(data)
      return false
    })

    // Track mouse mode: DECSET ?1000/1002/1003 h (enable) / l (disable)
    const csiDecsetDisposable = term.parser.registerCsiHandler(
      { prefix: '?', final: 'h' },
      (params) => {
        for (let i = 0; i < params.length; i++) {
          const p = params[i]
          if (typeof p === 'number') {
            if (p === 1000 || p === 1002 || p === 1003) mouseStateRef.current.mouseTracking = true
            if (p === 1006) mouseStateRef.current.sgrMode = true
            if (p === 1049 || p === 47) predictiveEchoRef.current?.setAltScreen(true)
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
            if (p === 1000 || p === 1002 || p === 1003) mouseStateRef.current.mouseTracking = false
            if (p === 1006) mouseStateRef.current.sgrMode = false
            if (p === 1049 || p === 47) predictiveEchoRef.current?.setAltScreen(false)
          }
        }
        return false
      }
    )

    // Initial fit
    setTimeout(() => {
      fitAddon.fit()
      const { cols, rows } = term
      resize(cols, rows)
    }, 0)

    // Handle user input -> send to WebSocket
    const dataDisposable = term.onData((data) => {
      predictiveEcho.handleInput(data)
      sendInput(data)
    })

    const HIGH_WATER = 5
    let pendingWrites = 0
    let paused = false

    const unsubscribe = subscribeOutput((data) => {
      if (data instanceof Uint8Array) {
        predictiveEcho.handleOutput(data)
      }
      pendingWrites++
      if (pendingWrites >= HIGH_WATER && !paused) {
        paused = true
        sendControl(0x32)
      }
      term.write(data instanceof Uint8Array ? data : data, () => {
        pendingWrites--
        if (pendingWrites === 0 && paused) {
          paused = false
          sendControl(0x33)
        }
      })
    })

    const handlePredictiveEchoChanged = (e: Event) => {
      predictiveEcho.enabled = (e as CustomEvent).detail as boolean
    }
    window.addEventListener('predictive-echo-changed', handlePredictiveEchoChanged)

    window.addEventListener('resize', debouncedResize)

    const vv = window.visualViewport
    vv?.addEventListener('resize', debouncedResize)
    
    const container = containerRef.current
    container.addEventListener('touchstart', handleTouchStart, { passive: true })
    container.addEventListener('touchmove', handleTouchMove, { passive: false })
    container.addEventListener('touchend', handleTouchEnd, { passive: true })

    // Handle image paste from clipboard
    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return

      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const blob = item.getAsFile()
          if (!blob) return

           try {
             const response = await fetch(`/api/upload-image`, {
              method: 'POST',
              headers: { 'Content-Type': blob.type },
              body: blob,
            })
            if (!response.ok) throw new Error(`Upload failed: ${response.status}`)
            const { path } = await response.json()
            sendInput(path)
          } catch (err) {
            console.error('[Terminal] Image upload failed:', err)
          }
          return
        }
      }
    }
    container.addEventListener('paste', handlePaste, true)

    const handleCopyViewport = () => {
      if (document.getElementById('copy-mode-overlay')) return

      const lines: string[] = []
      const buf = term.buffer.active
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i)
        if (line) lines.push(line.translateToString(true))
      }
      const text = lines.join('\n').replace(/\n+$/, '')
      if (!text) return

      const overlay = document.createElement('div')
      overlay.id = 'copy-mode-overlay'
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;background:#0d1117;'

      const header = document.createElement('div')
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #30363d;flex-shrink:0;'

      const hint = document.createElement('span')
      hint.textContent = 'Select text to copy'
      hint.style.cssText = 'color:#8b949e;font-size:12px;'

      const btnGroup = document.createElement('div')
      btnGroup.style.cssText = 'display:flex;gap:8px;'

      const btnStyle = 'padding:4px 10px;border-radius:6px;border:1px solid #30363d;font-size:12px;background:#21262d;color:#e6edf3;-webkit-appearance:none;'

      const selectAllBtn = document.createElement('button')
      selectAllBtn.textContent = 'Select All'
      selectAllBtn.style.cssText = btnStyle

      const copyAllBtn = document.createElement('button')
      copyAllBtn.textContent = 'Copy All'
      copyAllBtn.style.cssText = btnStyle + 'background:#58a6ff;color:#fff;border-color:#58a6ff;'

      const closeBtn = document.createElement('button')
      closeBtn.textContent = '✕'
      closeBtn.style.cssText = btnStyle + 'min-width:32px;'

      btnGroup.append(selectAllBtn, copyAllBtn, closeBtn)
      header.append(hint, btnGroup)

      const ta = document.createElement('textarea')
      ta.readOnly = true
      ta.value = text
      ta.style.cssText = 'flex:1;margin:0;padding:12px;border:none;resize:none;outline:none;background:#0d1117;color:#e6edf3;font-family:Menlo,Monaco,"Courier New",monospace;font-size:12px;line-height:1.5;-webkit-user-select:text;user-select:text;-webkit-touch-callout:default;'

      overlay.append(header, ta)
      document.body.appendChild(overlay)

      ta.scrollTop = ta.scrollHeight

      const close = () => { overlay.remove() }
      closeBtn.onclick = close
      selectAllBtn.onclick = () => { ta.focus(); ta.select() }
      copyAllBtn.onclick = () => {
        ta.focus()
        ta.select()
        fallbackCopy(text)
        setShowCopied(true)
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = window.setTimeout(() => setShowCopied(false), 1500)
      }
    }
    window.addEventListener('terminal-copy-viewport', handleCopyViewport)

    return () => {
      unsubscribe()
      dataDisposable.dispose()
      oscDisposable.dispose()
      csiDecsetDisposable.dispose()
      csiDecrstDisposable.dispose()
      window.removeEventListener('predictive-echo-changed', handlePredictiveEchoChanged)
      window.removeEventListener('resize', debouncedResize)
      vv?.removeEventListener('resize', debouncedResize)
      window.removeEventListener('terminal-copy-viewport', handleCopyViewport)
      if (xtermScreen) {
        xtermScreen.removeEventListener('mousedown', onMouseDownCapture, { capture: true })
        xtermScreen.removeEventListener('mousemove', onMouseMoveCapture, { capture: true })
        xtermScreen.removeEventListener('mouseup', onMouseUpCapture, { capture: true })
      }
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      if (pinchWriteTimerRef.current) clearTimeout(pinchWriteTimerRef.current)
      if (pinchResizeTimerRef.current) clearTimeout(pinchResizeTimerRef.current)
      container.removeEventListener('touchstart', handleTouchStart)
      container.removeEventListener('touchmove', handleTouchMove)
      container.removeEventListener('touchend', handleTouchEnd)
      container.removeEventListener('paste', handlePaste, true)
      term.dispose()
    }
  }, [subscribeOutput, sendInput, sendControl, resize, handleResize, debouncedResize, handleTouchStart, handleTouchMove, handleTouchEnd])

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
      {showCopied && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg bg-accent-green/80 backdrop-blur-sm border border-accent-green/50 text-white text-sm font-mono pointer-events-none select-none z-10">
          Copied!
        </div>
      )}
    </div>
  )
}
