import React, { useState, useEffect, useRef, useCallback } from 'react'

const DRAFT_KEY = 'ttyd_text_input_draft'
const LINE_HEIGHT = 20
const PADDING_Y = 12
const SINGLE_LINE = LINE_HEIGHT + PADDING_Y
const MAX_HEIGHT_RATIO = 0.4

interface TextInputBarProps {
  isOpen: boolean
  onClose: () => void
  onSend: (text: string) => void
}

export const TextInputModal: React.FC<TextInputBarProps> = ({ isOpen, onClose, onSend }) => {
  const [text, setText] = useState(() => sessionStorage.getItem(DRAFT_KEY) || '')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const maxHeight = typeof window !== 'undefined'
    ? (window.visualViewport?.height || window.innerHeight) * MAX_HEIGHT_RATIO
    : 200

  const autoResize = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = `${SINGLE_LINE}px`
    const scrollH = ta.scrollHeight
    ta.style.height = `${Math.min(scrollH, maxHeight)}px`
    ta.style.overflowY = scrollH > maxHeight ? 'auto' : 'hidden'
  }, [maxHeight])

  useEffect(() => {
    if (isOpen) {
      const draft = sessionStorage.getItem(DRAFT_KEY)
      if (draft) setText(draft)
      setTimeout(() => {
        textareaRef.current?.focus()
        autoResize()
      }, 50)
    }
  }, [isOpen, autoResize])

  useEffect(() => {
    autoResize()
  }, [text, autoResize])

  const handleTextChange = useCallback((value: string) => {
    setText(value)
    sessionStorage.setItem(DRAFT_KEY, value)
  }, [])

  const handleSend = useCallback(() => {
    if (!text) return
    onSend(text)
    setText('')
    sessionStorage.removeItem(DRAFT_KEY)
    onClose()
  }, [text, onSend, onClose])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!isOpen) return null

  return (
    <div className="shrink-0 bg-bg-secondary border-t border-border-subtle flex items-end gap-1.5 px-2 py-1.5">
      <button
        onClick={onClose}
        className="shrink-0 w-8 h-8 flex items-center justify-center text-text-secondary active:bg-bg-tertiary rounded-lg text-sm mb-[1px]"
      >
        ✕
      </button>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={e => handleTextChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type or paste text..."
        rows={1}
        className="flex-1 bg-bg-primary border border-border-subtle rounded-lg px-3 py-1.5 font-mono text-sm text-text-primary leading-5 focus:outline-none focus:border-accent-blue resize-none min-w-0"
        style={{ height: `${SINGLE_LINE}px`, overflowY: 'hidden' }}
      />
      <button
        onClick={handleSend}
        disabled={!text}
        className="shrink-0 px-3 h-8 bg-accent-blue text-white text-sm rounded-lg font-medium active:opacity-80 disabled:opacity-40 mb-[1px]"
      >
        Send
      </button>
    </div>
  )
}
