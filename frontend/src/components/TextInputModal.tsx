import React, { useState, useEffect, useRef } from 'react'

interface TextInputModalProps {
  isOpen: boolean
  onClose: () => void
  onSend: (text: string) => void
}

export const TextInputModal: React.FC<TextInputModalProps> = ({ isOpen, onClose, onSend }) => {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (isOpen) {
      // Focus textarea with a slight delay to ensure modal is rendered
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus()
        }
      }, 50)
    } else {
      setText('')
    }
  }, [isOpen])

  const handleSend = () => {
    if (!text) return
    onSend(text)
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
      <div 
        className="bg-bg-secondary w-full max-w-lg mx-4 rounded-xl shadow-2xl border border-border-subtle flex flex-col h-[50vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border-subtle">
          <h2 className="text-lg font-semibold text-text-primary">Input Text</h2>
          <button 
            onClick={onClose}
            className="p-2 text-text-secondary hover:text-text-primary transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 p-4">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type or paste long text here..."
            className="w-full h-full bg-bg-primary border border-border-subtle rounded p-3 font-mono text-sm text-text-primary focus:outline-none focus:border-accent-blue resize-none"
          />
        </div>

        <div className="p-4 border-t border-border-subtle flex justify-end gap-3">
          <button 
            onClick={onClose}
            className="px-4 py-2 rounded text-text-secondary hover:bg-bg-tertiary transition-colors"
          >
            Cancel
          </button>
          <button 
            onClick={handleSend}
            disabled={!text}
            className="px-4 py-2 bg-accent-blue text-white rounded font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Send (Cmd+Enter)
          </button>
        </div>
      </div>
    </div>
  )
}
