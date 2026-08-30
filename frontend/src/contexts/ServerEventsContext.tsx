import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useTerminal } from './TerminalContext'
import { withTerminalTarget } from '../utils/terminal-api'

const POLL_INTERVAL = 5000

interface RawTmuxSession {
  name: string
  windows: number
  attached: boolean
  last_activity: number
  agent_status?: AgentStatus
}

interface RawDiscoveredSession {
  name: string
  path: string
  relativePath: string
  command: string
  attached: boolean
  windows: number
  lastActivity: number
  agentStatus?: AgentStatus
}

interface RawProjectGroup {
  projectRoot: string
  displayName: string
  sessions: RawDiscoveredSession[]
}

interface RawTmuxPayload {
  sessions?: RawTmuxSession[]
  currentSession?: string | null
  scannedAt?: number
  projectGroups?: RawProjectGroup[]
  otherSessions?: RawDiscoveredSession[]
}

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

interface RawHerdrPane {
  pane_id: string
  workspace_id: string
  agent?: string
  cwd?: string
  foreground_cwd?: string
  focused?: boolean
  revision?: number
  agent_status?: AgentStatus
}

interface RawHerdrWorkspace {
  workspace_id: string
  label?: string
}

interface RawHerdrAgent {
  pane_id: string
  agent?: string
  agent_status?: AgentStatus
}

interface RawHerdrPayload {
  panes?: RawHerdrPane[]
  workspaces?: RawHerdrWorkspace[]
  agents?: RawHerdrAgent[]
}

export interface TmuxSession {
  name: string
  windows: number
  attached: boolean
  lastActivity: number
  hasNewActivity: boolean
  agentStatus?: AgentStatus
}

export interface DiscoveredTmuxSession extends TmuxSession {
  path: string
  relativePath: string
  command: string
}

export interface TmuxProjectGroup {
  projectRoot: string
  displayName: string
  sessions: DiscoveredTmuxSession[]
}

interface ServerEventsContextValue {
  branch: string
  path: string
  tuiActive: boolean
  tmuxSessions: TmuxSession[]
  projectGroups: TmuxProjectGroup[]
  otherSessions: DiscoveredTmuxSession[]
  tmuxScannedAt: number
  currentTmuxSession: string | null
  isOffline: boolean
  clientTty: string | null
  sessionsLoaded: boolean
  refresh: () => void
}

interface EventPayload {
  branch?: string
  path?: string
  tuiActive?: boolean
  tmux?: RawTmuxPayload
  herdr?: RawHerdrPayload
  event?: unknown
}

const ServerEventsContext = createContext<ServerEventsContextValue | null>(null)

export const useServerEvents = () => {
  const context = useContext(ServerEventsContext)
  if (!context) throw new Error('useServerEvents must be used within ServerEventsProvider')
  return context
}

export const ServerEventsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { clientTty, mux, paneId } = useTerminal()
  const clientTtyRef = useRef<string | null>(null)
  const [branch, setBranch] = useState('')
  const [path, setPath] = useState('')
  const [rawSessions, setRawSessions] = useState<RawTmuxSession[]>([])
  const [rawProjectGroups, setRawProjectGroups] = useState<RawProjectGroup[]>([])
  const [rawOtherSessions, setRawOtherSessions] = useState<RawDiscoveredSession[]>([])
  const [tmuxScannedAt, setTmuxScannedAt] = useState(0)
  const [currentTmuxSession, setCurrentTmuxSession] = useState<string | null>(null)
  const [isOffline, setIsOffline] = useState(false)
  const [tuiActive, setTuiActive] = useState(false)
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [lastViewedMap, setLastViewedMap] = useState<Record<string, number>>({})
  const pollIntervalRef = useRef<number | null>(null)
  const agentStatusesRef = useRef<Record<string, AgentStatus>>({})
  const notificationTimersRef = useRef<Record<string, number>>({})

  useEffect(() => {
    if (currentTmuxSession) {
      setLastViewedMap(previous => ({ ...previous, [currentTmuxSession]: Math.floor(Date.now() / 1000) }))
    }
  }, [currentTmuxSession])

  const hasNewActivity = useCallback((name: string, lastActivity: number) => (
    mux !== 'herdr'
    &&
    !!currentTmuxSession
    && name !== currentTmuxSession
    && lastActivity > (lastViewedMap[name] ?? 0)
  ), [currentTmuxSession, lastViewedMap, mux])

  const tmuxSessions = useMemo<TmuxSession[]>(() => rawSessions.map(session => ({
    name: session.name,
    windows: session.windows,
    attached: session.attached,
    lastActivity: session.last_activity,
    hasNewActivity: hasNewActivity(session.name, session.last_activity),
    agentStatus: session.agent_status,
  })), [rawSessions, hasNewActivity])

  const mapDiscovered = useCallback((session: RawDiscoveredSession): DiscoveredTmuxSession => ({
    ...session,
    hasNewActivity: hasNewActivity(session.name, session.lastActivity),
  }), [hasNewActivity])

  const projectGroups = useMemo<TmuxProjectGroup[]>(() => rawProjectGroups.map(group => ({
    ...group,
    sessions: group.sessions.map(mapDiscovered),
  })), [rawProjectGroups, mapDiscovered])

  const otherSessions = useMemo(() => rawOtherSessions.map(mapDiscovered), [rawOtherSessions, mapDiscovered])

  const applyTmux = useCallback((tmux: RawTmuxPayload | undefined) => {
    setRawSessions(tmux?.sessions ?? [])
    setRawProjectGroups(tmux?.projectGroups ?? [])
    setRawOtherSessions(tmux?.otherSessions ?? [])
    setTmuxScannedAt(tmux?.scannedAt ?? 0)
    setCurrentTmuxSession(tmux?.currentSession ?? null)
    setSessionsLoaded(true)
  }, [])

  const applyHerdr = useCallback((payload: RawHerdrPayload) => {
    const panes = payload.panes ?? []
    const workspaces = payload.workspaces ?? []
    const agents = new Map((payload.agents ?? []).map(agent => [agent.pane_id, agent]))
    const nextStatuses = Object.fromEntries(panes.map(pane => [
      pane.pane_id,
      agents.get(pane.pane_id)?.agent_status ?? pane.agent_status ?? 'unknown',
    ])) as Record<string, AgentStatus>
    for (const [statusPaneId, nextStatus] of Object.entries(nextStatuses)) {
      const previousStatus = agentStatusesRef.current[statusPaneId]
      if (nextStatus === 'working' && notificationTimersRef.current[statusPaneId]) {
        window.clearTimeout(notificationTimersRef.current[statusPaneId])
        delete notificationTimersRef.current[statusPaneId]
      }
      if (previousStatus !== 'working' || !['idle', 'blocked', 'done'].includes(nextStatus)) continue
      if (notificationTimersRef.current[statusPaneId]) {
        window.clearTimeout(notificationTimersRef.current[statusPaneId])
      }
      notificationTimersRef.current[statusPaneId] = window.setTimeout(() => {
        delete notificationTimersRef.current[statusPaneId]
        if (agentStatusesRef.current[statusPaneId] !== nextStatus) return
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          const body = nextStatus === 'blocked'
            ? `${statusPaneId} is waiting for confirmation`
            : `${statusPaneId} is ${nextStatus}`
          new Notification('Rust Terminal agent update', { body, tag: `herdr-${statusPaneId}-${nextStatus}` })
        }
        navigator.vibrate?.(nextStatus === 'blocked' ? [120, 80, 120] : 120)
      }, 1500)
    }
    agentStatusesRef.current = nextStatuses
    const toSession = (pane: RawHerdrPane): RawDiscoveredSession => {
      const agent = agents.get(pane.pane_id)
      const sessionPath = pane.foreground_cwd ?? pane.cwd ?? ''
      const pathParts = sessionPath.split('/').filter(Boolean)
      return {
        name: pane.pane_id,
        path: sessionPath,
        relativePath: pathParts[pathParts.length - 1] ?? sessionPath,
        command: agent?.agent ?? 'shell',
        attached: pane.focused ?? false,
        windows: 1,
        lastActivity: pane.revision ?? 0,
        agentStatus: agent?.agent_status ?? pane.agent_status ?? 'unknown',
      }
    }
    const workspaceIds = new Set(workspaces.map(workspace => workspace.workspace_id))
    const groups = workspaces.map(workspace => ({
      projectRoot: workspace.workspace_id,
      displayName: workspace.label ?? workspace.workspace_id,
      sessions: panes.filter(pane => pane.workspace_id === workspace.workspace_id).map(toSession),
    }))
    const other = panes.filter(pane => !workspaceIds.has(pane.workspace_id)).map(toSession)
    setRawSessions(panes.map(pane => ({
      name: pane.pane_id,
      windows: 1,
      attached: pane.focused ?? false,
      last_activity: pane.revision ?? 0,
      agent_status: agents.get(pane.pane_id)?.agent_status ?? pane.agent_status ?? 'unknown',
    })))
    setRawProjectGroups(groups)
    setRawOtherSessions(other)
    setTmuxScannedAt(Math.floor(Date.now() / 1000))
    setCurrentTmuxSession(paneId)
    const currentPane = panes.find(pane => pane.pane_id === paneId)
    const currentAgent = paneId ? agents.get(paneId) : undefined
    setTuiActive(Boolean(currentAgent?.agent ?? currentPane?.agent))
    setSessionsLoaded(true)
  }, [paneId])

  useEffect(() => () => {
    Object.values(notificationTimersRef.current).forEach(timer => window.clearTimeout(timer))
    notificationTimersRef.current = {}
  }, [])

  const applyData = useCallback((data: EventPayload) => {
    setBranch(data.branch ?? '')
    setPath(data.path ?? '')
    setTuiActive(data.tuiActive ?? false)
    applyTmux(data.tmux)
    setIsOffline(false)
  }, [applyTmux])

  const fetchPollData = useCallback(async () => {
    if (mux === 'herdr') {
      try {
        const [diffRes, herdrRes] = await Promise.all([
          fetch(withTerminalTarget('/api/diff', mux, paneId, clientTtyRef.current), { signal: AbortSignal.timeout(3000) }),
          fetch('/api/herdr/list', { signal: AbortSignal.timeout(3000) }),
        ])
        if (diffRes.ok) {
          const data = await diffRes.json()
          setBranch(data.branch ?? '')
          setPath(data.git_root ?? data.cwd ?? '')
        }
        if (herdrRes.ok) applyHerdr(await herdrRes.json() as RawHerdrPayload)
        setIsOffline(!herdrRes.ok)
      } catch (error) {
        console.error('[ServerEvents] Herdr poll failed:', error)
        setIsOffline(true)
      }
      return
    }
    try {
      const ttyParam = clientTtyRef.current ? `?client_tty=${encodeURIComponent(clientTtyRef.current)}` : ''
      const [diffRes, tmuxRes, paneModeRes] = await Promise.all([
        fetch(withTerminalTarget('/api/diff', mux, paneId, clientTtyRef.current), { signal: AbortSignal.timeout(3000) }),
        fetch(`/api/tmux/list${ttyParam}`, { signal: AbortSignal.timeout(3000) }),
        fetch(`/api/tmux/pane-mode${ttyParam}`, { signal: AbortSignal.timeout(3000) }),
      ])
      if (diffRes.ok) {
        const data = await diffRes.json()
        setBranch(data.branch ?? '')
        setPath(data.git_root ?? data.cwd ?? '')
      }
      if (tmuxRes.ok) applyTmux(await tmuxRes.json())
      if (paneModeRes.ok) setTuiActive((await paneModeRes.json()).tuiActive ?? false)
      setIsOffline(false)
    } catch (error) {
      console.error('[ServerEvents] Poll failed:', error)
      setIsOffline(true)
    }
  }, [applyHerdr, applyTmux, mux, paneId])

  const startPolling = useCallback(() => {
    if (pollIntervalRef.current) return
    void fetchPollData()
    pollIntervalRef.current = window.setInterval(fetchPollData, POLL_INTERVAL)
  }, [fetchPollData])

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) window.clearInterval(pollIntervalRef.current)
    pollIntervalRef.current = null
  }, [])

  const refresh = useCallback(() => { void fetchPollData() }, [fetchPollData])

  useEffect(() => { clientTtyRef.current = clientTty }, [clientTty])

  useEffect(() => {
    if (mux === 'herdr') {
      void fetchPollData()
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/tmux/list', { signal: AbortSignal.timeout(3000) })
        if (response.ok && !cancelled) {
          applyTmux(await response.json())
        }
      } catch (error) {
        console.error('[ServerEvents] Initial session load failed:', error)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [applyTmux, fetchPollData, mux])

  useEffect(() => {
    if (mux === 'herdr') {
      let eventSource: EventSource | null = null
      let reconnectTimer: number | null = null
      let stopped = false
      const connect = () => {
        if (stopped) return
        const paneParam = paneId ? `&pane=${encodeURIComponent(paneId)}` : ''
        eventSource = new EventSource(`/api/events?mux=herdr${paneParam}`)
        eventSource.onopen = () => stopPolling()
        eventSource.onmessage = event => {
          try {
            const data = JSON.parse(event.data) as EventPayload
            if (data.herdr) applyHerdr(data.herdr)
            setIsOffline(false)
          } catch (error) {
            console.error('[ServerEvents] Invalid herdr SSE payload:', error)
          }
        }
        eventSource.onerror = () => {
          eventSource?.close()
          eventSource = null
          startPolling()
          if (reconnectTimer) window.clearTimeout(reconnectTimer)
          reconnectTimer = window.setTimeout(connect, POLL_INTERVAL)
        }
      }
      connect()
      return () => {
        stopped = true
        eventSource?.close()
        if (reconnectTimer) window.clearTimeout(reconnectTimer)
        stopPolling()
      }
    }
    if (!clientTty) return
    let eventSource: EventSource | null = null
    let reconnectTimer: number | null = null
    let stopped = false
    const connect = () => {
      if (stopped) return
      eventSource = new EventSource(`/api/events?client_tty=${encodeURIComponent(clientTty)}`)
      eventSource.onopen = () => stopPolling()
      eventSource.onmessage = event => {
        try {
          applyData(JSON.parse(event.data) as EventPayload)
        } catch (error) {
          console.error('[ServerEvents] Invalid SSE payload:', error)
        }
      }
      eventSource.onerror = () => {
        eventSource?.close()
        eventSource = null
        startPolling()
        if (reconnectTimer) window.clearTimeout(reconnectTimer)
        reconnectTimer = window.setTimeout(connect, POLL_INTERVAL)
      }
    }
    connect()
    return () => {
      stopped = true
      eventSource?.close()
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      stopPolling()
    }
  }, [clientTty, mux, paneId, applyData, applyHerdr, startPolling, stopPolling])

  const value = useMemo<ServerEventsContextValue>(() => ({
    branch,
    path,
    tuiActive,
    tmuxSessions,
    projectGroups,
    otherSessions,
    tmuxScannedAt,
    currentTmuxSession,
    isOffline,
    clientTty,
    sessionsLoaded,
    refresh,
  }), [branch, path, tuiActive, tmuxSessions, projectGroups, otherSessions, tmuxScannedAt, currentTmuxSession, isOffline, clientTty, sessionsLoaded, refresh])

  return <ServerEventsContext.Provider value={value}>{children}</ServerEventsContext.Provider>
}
