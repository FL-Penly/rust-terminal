import React, { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from 'react'
import type { TmuxSession } from '../hooks/useTmuxSessions'
import { useTerminal } from './TerminalContext'

const POLL_INTERVAL = 5000

interface ServerEventsContextValue {
  branch: string
  path: string
  tmuxSessions: TmuxSession[]
  currentTmuxSession: string | null
  isOffline: boolean
  clientTty: string | null
  sessionsLoaded: boolean
  refresh: () => void
}

const ServerEventsContext = createContext<ServerEventsContextValue | null>(null)

export const useServerEvents = () => {
  const context = useContext(ServerEventsContext)
  if (!context) {
    throw new Error('useServerEvents must be used within a ServerEventsProvider')
  }
  return context
}

export const ServerEventsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { clientTty } = useTerminal()
  const clientTtyRef = useRef<string | null>(null)
  const [branch, setBranch] = useState('')
  const [path, setPath] = useState('')
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSession[]>([])
  const [currentTmuxSession, setCurrentTmuxSession] = useState<string | null>(null)
  const [isOffline, setIsOffline] = useState(false)
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)
  const pollIntervalRef = useRef<number | null>(null)
  const usingSSERef = useRef(true)

  const applyData = useCallback((data: { branch: string; path: string; tmux: { sessions: TmuxSession[]; currentSession: string | null } }) => {
    setBranch(data.branch || '')
    setPath(data.path || '')
    setTmuxSessions(data.tmux?.sessions || [])
    setCurrentTmuxSession(data.tmux?.currentSession || null)
    setIsOffline(false)
    setSessionsLoaded(true)
  }, [])

   const fetchPollData = useCallback(async () => {
     try {
       const ttyParam = clientTtyRef.current ? `?client_tty=${encodeURIComponent(clientTtyRef.current)}` : ''
       const [diffRes, tmuxRes] = await Promise.all([
         fetch(`/api/diff`, { signal: AbortSignal.timeout(3000) }),
         fetch(`/api/tmux/list${ttyParam}`, { signal: AbortSignal.timeout(3000) }),
       ])

      let branchVal = ''
      let pathVal = ''
      if (diffRes.ok) {
        const diffData = await diffRes.json()
        branchVal = diffData.branch || ''
        pathVal = diffData.git_root || diffData.cwd || ''
      }

      let sessions: TmuxSession[] = []
      let currentSession: string | null = null
      if (tmuxRes.ok) {
        const tmuxData = await tmuxRes.json()
        sessions = tmuxData.sessions || []
        currentSession = tmuxData.currentSession || null
      }

      setBranch(branchVal)
      setPath(pathVal)
      setTmuxSessions(sessions)
      setCurrentTmuxSession(currentSession)
      setIsOffline(false)
      setSessionsLoaded(true)
    } catch {
      setIsOffline(true)
    }
  }, [])

  const startPolling = useCallback(() => {
    if (pollIntervalRef.current) return
    fetchPollData()
    pollIntervalRef.current = window.setInterval(fetchPollData, POLL_INTERVAL)
  }, [fetchPollData])

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }, [])

  const refresh = useCallback(() => {
    fetchPollData()
  }, [fetchPollData])

  useEffect(() => {
    clientTtyRef.current = clientTty
  }, [clientTty])

  useEffect(() => {
    let cancelled = false
    const fetchInitialSessions = async () => {
      try {
        const res = await fetch('/api/tmux/list', { signal: AbortSignal.timeout(3000) })
        if (res.ok && !cancelled) {
          const data = await res.json()
          setTmuxSessions(data.sessions || [])
          setCurrentTmuxSession(data.currentSession || null)
          setSessionsLoaded(true)
        }
      } catch {}
    }
    fetchInitialSessions()
    return () => { cancelled = true }
  }, [])

   useEffect(() => {
     if (!clientTty) return

     const ttyParam = `?client_tty=${encodeURIComponent(clientTty)}`
     const url = `/api/events${ttyParam}`
     const es = new EventSource(url)
    eventSourceRef.current = es

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        applyData(data)
      } catch {}
    }

    es.onerror = () => {
      es.close()
      eventSourceRef.current = null
      usingSSERef.current = false
      startPolling()
    }

    return () => {
      es.close()
      eventSourceRef.current = null
      stopPolling()
    }
  }, [clientTty, applyData, startPolling, stopPolling])

  const contextValue = useMemo(() => ({
    branch,
    path,
    tmuxSessions,
    currentTmuxSession,
    isOffline,
    clientTty,
    sessionsLoaded,
    refresh,
  }), [branch, path, tmuxSessions, currentTmuxSession, isOffline, clientTty, sessionsLoaded, refresh])

  return (
    <ServerEventsContext.Provider value={contextValue}>
      {children}
    </ServerEventsContext.Provider>
  )
}
