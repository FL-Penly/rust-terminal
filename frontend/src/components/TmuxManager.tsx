import React, { useState, useEffect, useRef } from 'react'
import { useTerminal, type TerminalMux } from '../contexts/TerminalContext'

interface NewSessionModalProps {
  isOpen: boolean
  onClose: () => void
  cwd?: string
  onCreated?: () => void
  targetMux?: TerminalMux
}

export const NewSessionModal: React.FC<NewSessionModalProps> = ({ isOpen, onClose, cwd, onCreated, targetMux }) => {
  const { sendInput, clientTty, mux: connectedMux, switchTerminal } = useTerminal()
  const mux = targetMux ?? connectedMux
  const [sessionName, setSessionName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      setSessionName('')
      const timer = setTimeout(() => inputRef.current?.focus(), 100)
      return () => clearTimeout(timer)
    }
  }, [isOpen])

  const handleCreate = async () => {
    const name = sessionName.trim()
    if (!name) return
    onClose()
    try {
      if (mux === 'herdr') {
        const cwdParam = cwd ? `&cwd=${encodeURIComponent(cwd)}` : ''
        const response = await fetch(`/api/herdr/create?name=${encodeURIComponent(name)}${cwdParam}`, { signal: AbortSignal.timeout(3000) })
        if (!response.ok) throw new Error(await response.text())
        const data = await response.json() as { paneId?: string }
        if (!data.paneId) throw new Error('Herdr did not return the new pane id')
        onCreated?.()
        switchTerminal('herdr', data.paneId)
        return
      }
      if (connectedMux !== 'tmux') throw new Error('Choose a tmux session before creating another one')
      if (clientTty) {
        const cwdParam = cwd ? `&cwd=${encodeURIComponent(cwd)}` : ''
        const url = `/api/tmux/create?name=${encodeURIComponent(name)}&client_tty=${encodeURIComponent(clientTty)}${cwdParam}`
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
        if (res.ok) {
          sessionStorage.setItem('ttyd_last_tmux_session', name)
          onCreated?.()
          return
        }
      }
    } catch (error) {
      console.error('[TmuxManager] Create failed:', error)
      if (mux === 'herdr') return
    }
    if (mux === 'tmux') {
      sendInput(` tmux new-session -d -s ${name} 2>/dev/null; tmux attach -t ${name}\r`)
      sessionStorage.setItem('ttyd_last_tmux_session', name)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleCreate()
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  if (!isOpen) return null

  return (
    <div 
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-sm bg-bg-secondary rounded-xl p-4">
        <h3 className="text-lg font-semibold mb-4">{mux === 'herdr' ? 'New Herdr Workspace' : 'New Tmux Session'}</h3>
        
        <input
          ref={inputRef}
          type="text"
          value={sessionName}
          onChange={(e) => setSessionName(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={mux === 'herdr' ? 'Workspace name (e.g. work, claude)' : 'Session name (e.g. work, claude)'}
          className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-purple mb-4"
        />
        
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!sessionName.trim()}
            className="px-4 py-2 rounded-lg bg-accent-purple text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Create & Attach
          </button>
        </div>
      </div>
    </div>
  )
}
