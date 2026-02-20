import { useState, useEffect, useCallback } from 'react'

const POLL_INTERVAL = 5000

export interface TmuxSession {
  name: string
  windows: number
  attached: boolean
}

export function useTmuxSessions() {
  const [sessions, setSessions] = useState<TmuxSession[]>([])
  const [currentSession, setCurrentSession] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

   const fetchSessions = useCallback(async () => {
     try {
       const response = await fetch(`/api/tmux/list`, { signal: AbortSignal.timeout(3000) })
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      
      const data = await response.json()
      setSessions(data.sessions || [])
      setCurrentSession(data.currentSession || null)
      setError(null)
    } catch (err) {
      setError('Failed to fetch sessions')
      setSessions([])
      setCurrentSession(null)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSessions()
    const interval = setInterval(fetchSessions, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchSessions])

  const refresh = useCallback(() => {
    setIsLoading(true)
    fetchSessions()
  }, [fetchSessions])

  return {
    sessions,
    currentSession,
    isLoading,
    error,
    refresh
  }
}
