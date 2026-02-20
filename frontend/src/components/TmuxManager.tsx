import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTerminal } from '../contexts/TerminalContext'

interface TmuxSession {
  name: string
  windows: number
  attached: boolean
}

interface NewSessionModalProps {
  isOpen: boolean
  onClose: () => void
}

export const NewSessionModal: React.FC<NewSessionModalProps> = ({ isOpen, onClose }) => {
  const { sendInput, clientTty } = useTerminal()
  const [sessionName, setSessionName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      setSessionName('')
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [isOpen])

  const handleCreate = async () => {
    const name = sessionName.trim()
    if (!name) return
    onClose()
     try {
       if (clientTty) {
         const url = `/api/tmux/create?name=${encodeURIComponent(name)}&client_tty=${encodeURIComponent(clientTty)}`
         const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
        if (res.ok) {
          sessionStorage.setItem('ttyd_last_tmux_session', name)
          return
        }
      }
    } catch {}
    sendInput(` tmux new-session -d -s ${name} 2>/dev/null; tmux attach -t ${name}\r`)
    sessionStorage.setItem('ttyd_last_tmux_session', name)
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
        <h3 className="text-lg font-semibold mb-4">New Tmux Session</h3>
        
        <input
          ref={inputRef}
          type="text"
          value={sessionName}
          onChange={(e) => setSessionName(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Session name (e.g. work, claude)"
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

interface SessionListModalProps {
  isOpen: boolean
  onClose: () => void
}

export const SessionListModal: React.FC<SessionListModalProps> = ({ isOpen, onClose }) => {
  const { sendInput, clientTty } = useTerminal()
  const [sessions, setSessions] = useState<TmuxSession[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

   const fetchSessions = useCallback(async () => {
     setIsLoading(true)
     setError(null)
     try {
       const response = await fetch(`/api/tmux/list`, { signal: AbortSignal.timeout(5000) })
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      
      const data = await response.json()
      setSessions(data.sessions || [])
    } catch (err) {
      setError('Failed to fetch sessions')
      setSessions([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOpen) {
      fetchSessions()
    }
  }, [isOpen, fetchSessions])

   const handleAttach = async (name: string) => {
     onClose()
     try {
       if (clientTty) {
         const url = `/api/tmux/switch?session=${encodeURIComponent(name)}&client_tty=${encodeURIComponent(clientTty)}`
         const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
        if (res.ok) {
          sessionStorage.setItem('ttyd_last_tmux_session', name)
          return
        }
      }
    } catch {}
    sendInput(` tmux switch-client -t ${name} 2>/dev/null || tmux attach -t ${name}\r`)
    sessionStorage.setItem('ttyd_last_tmux_session', name)
  }

   const handleKill = async (name: string) => {
     try {
       const url = `/api/tmux/kill?name=${encodeURIComponent(name)}`
       await fetch(url, { signal: AbortSignal.timeout(5000) })
      fetchSessions()
    } catch (err) {
      alert('Failed to kill session')
    }
  }

  if (!isOpen) return null

  return (
    <div 
      className="fixed inset-0 z-50 bg-black/80 flex items-end justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-h-[70vh] bg-bg-primary rounded-t-2xl flex flex-col overflow-hidden">
        <div className="shrink-0 px-4 py-3 border-b border-border-subtle flex items-center justify-between">
          <h3 className="text-lg font-semibold">Tmux Sessions</h3>
          <button 
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-bg-tertiary text-text-secondary"
          >
            ✕
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div className="text-center text-text-muted py-8">Loading...</div>
          ) : error ? (
            <div className="text-center text-accent-red py-8">{error}</div>
          ) : sessions.length === 0 ? (
            <div className="text-center text-text-muted py-8">No tmux sessions</div>
          ) : (
            <div className="space-y-3">
              {sessions.map((session) => (
                <div 
                  key={session.name}
                  className="bg-bg-secondary border border-border-subtle rounded-lg p-3"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-text-primary">{session.name}</div>
                      <div className="text-xs text-text-secondary mt-1">
                        {session.windows} window{session.windows !== 1 ? 's' : ''}
                        {session.attached && (
                          <span className="text-accent-green ml-2">(attached)</span>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleAttach(session.name)}
                        className="px-3 py-1.5 rounded bg-accent-blue text-white text-sm"
                      >
                        Attach
                      </button>
                      <button
                        onClick={() => handleKill(session.name)}
                        className="px-3 py-1.5 rounded bg-accent-red text-white text-sm"
                      >
                        Kill
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
