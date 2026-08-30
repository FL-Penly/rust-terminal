import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useServerEvents, type AgentStatus, type DiscoveredTmuxSession, type TmuxProjectGroup } from '../contexts/ServerEventsContext'
import { useTerminal, type TerminalMux } from '../contexts/TerminalContext'
import { NewSessionModal } from './TmuxManager'

const COLLAPSED_GROUPS_KEY = 'tmux_sidebar_collapsed_groups'
const GROUP_ORDER_KEY = 'tmux_sidebar_group_order'
const SESSION_ORDER_KEY = 'tmux_sidebar_session_order'
const LONG_PRESS_DURATION = 1200
const DISCOVERY_POLL_INTERVAL = 5000

const AGENT_STATUS_STYLE: Record<AgentStatus, { label: string; dot: string; badge: string }> = {
  idle: { label: 'idle', dot: 'bg-accent-green', badge: 'bg-accent-green/15 text-accent-green' },
  working: { label: 'working', dot: 'bg-accent-blue animate-pulse', badge: 'bg-accent-blue/15 text-accent-blue' },
  blocked: { label: 'blocked', dot: 'bg-accent-orange animate-pulse', badge: 'bg-accent-orange/15 text-accent-orange' },
  done: { label: 'done', dot: 'bg-accent-purple', badge: 'bg-accent-purple/15 text-accent-purple' },
  unknown: { label: 'unknown', dot: 'bg-text-muted', badge: 'bg-bg-tertiary text-text-muted' },
}

interface TmuxSidebarProps {
  mobile: boolean
  onClose: () => void
  onCollapseDesktop: () => void
}

interface HerdrPane {
  pane_id: string
  workspace_id: string
  cwd?: string
  foreground_cwd?: string
  focused?: boolean
  revision?: number
  agent_status?: AgentStatus
}

interface HerdrWorkspace {
  workspace_id: string
  label?: string
}

interface HerdrAgent {
  pane_id: string
  agent?: string
  agent_status?: AgentStatus
}

interface HerdrListPayload {
  panes?: HerdrPane[]
  workspaces?: HerdrWorkspace[]
  agents?: HerdrAgent[]
}

interface TmuxListPayload {
  currentSession?: string | null
  projectGroups?: TmuxProjectGroup[]
  otherSessions?: DiscoveredTmuxSession[]
}

interface DiscoveryState {
  mux: TerminalMux | null
  projectGroups: TmuxProjectGroup[]
  otherSessions: DiscoveredTmuxSession[]
  currentSession: string | null
  loaded: boolean
  unavailable: boolean
}

const shellQuote = (value: string) => `'${value.split("'").join(`'"'"'`)}'`

const mapHerdrPayload = (payload: HerdrListPayload): Pick<DiscoveryState, 'projectGroups' | 'otherSessions' | 'currentSession'> => {
  const panes = payload.panes ?? []
  const workspaces = payload.workspaces ?? []
  const agents = new Map((payload.agents ?? []).map(agent => [agent.pane_id, agent]))
  const toSession = (pane: HerdrPane): DiscoveredTmuxSession => {
    const path = pane.foreground_cwd ?? pane.cwd ?? ''
    const pathParts = path.split('/').filter(Boolean)
    const agent = agents.get(pane.pane_id)
    return {
      name: pane.pane_id,
      path,
      relativePath: pathParts[pathParts.length - 1] ?? path,
      command: agent?.agent ?? 'shell',
      attached: pane.focused ?? false,
      windows: 1,
      lastActivity: pane.revision ?? 0,
      hasNewActivity: false,
      agentStatus: agent?.agent_status ?? pane.agent_status ?? 'unknown',
    }
  }
  const workspaceIds = new Set(workspaces.map(workspace => workspace.workspace_id))
  return {
    projectGroups: workspaces.map(workspace => ({
      projectRoot: workspace.workspace_id,
      displayName: workspace.label ?? workspace.workspace_id,
      sessions: panes.filter(pane => pane.workspace_id === workspace.workspace_id).map(toSession),
    })),
    otherSessions: panes.filter(pane => !workspaceIds.has(pane.workspace_id)).map(toSession),
    currentSession: null,
  }
}

export const TmuxSidebar: React.FC<TmuxSidebarProps> = ({ mobile, onClose, onCollapseDesktop }) => {
  const { sendInput, mux, paneId, switchTerminal } = useTerminal()
  const {
    projectGroups,
    otherSessions,
    currentTmuxSession,
    clientTty,
    path,
    isOffline,
    sessionsLoaded,
    refresh,
  } = useServerEvents()
  const [browserMux, setBrowserMux] = useState<TerminalMux>(mux)
  const [discovery, setDiscovery] = useState<DiscoveryState>({
    mux: null,
    projectGroups: [],
    otherSessions: [],
    currentSession: null,
    loaded: false,
    unavailable: false,
  })
  const [search, setSearch] = useState('')
  const [optimisticSession, setOptimisticSession] = useState<string | null>(null)
  const [switchingSession, setSwitchingSession] = useState<string | null>(null)
  const [isNewSessionOpen, setIsNewSessionOpen] = useState(false)
  const [quickShellLoading, setQuickShellLoading] = useState(false)
  const [killTarget, setKillTarget] = useState<string | null>(null)
  const [draggedGroup, setDraggedGroup] = useState<string | null>(null)
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null)
  const [draggedSession, setDraggedSession] = useState<{ groupKey: string; name: string } | null>(null)
  const [dragOverSession, setDragOverSession] = useState<{ groupKey: string; name: string } | null>(null)
  const [groupOrder, setGroupOrder] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(GROUP_ORDER_KEY) ?? '[]') as string[]
    } catch {
      return []
    }
  })
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const [sessionOrder, setSessionOrder] = useState<Record<string, string[]>>(() => {
    try {
      return JSON.parse(localStorage.getItem(SESSION_ORDER_KEY) ?? '{}') as Record<string, string[]>
    } catch {
      return {}
    }
  })
  const longPressTimer = useRef<number | null>(null)
  const longPressTriggered = useRef(false)
  const switchingSessionRef = useRef<string | null>(null)
  const browsingConnectedMux = browserMux === mux
  const sourceProjectGroups = browsingConnectedMux ? projectGroups : discovery.projectGroups
  const sourceOtherSessions = browsingConnectedMux ? otherSessions : discovery.otherSessions
  const sourceCurrentSession = browsingConnectedMux ? currentTmuxSession : discovery.currentSession
  const sourceLoaded = browsingConnectedMux ? sessionsLoaded : discovery.mux === browserMux && discovery.loaded
  const sourceUnavailable = browsingConnectedMux ? isOffline : discovery.mux === browserMux && discovery.unavailable
  const selectedSession = optimisticSession ?? sourceCurrentSession
  const sessionSwitchLocked = browserMux === 'tmux' && switchingSession !== null

  const sessionGroupKey = (groupKey: string) => `${browserMux}:${groupKey}`

  const orderSessions = (sessions: DiscoveredTmuxSession[], groupKey: string) => {
    const positions = new Map((sessionOrder[sessionGroupKey(groupKey)] ?? []).map((name, index) => [name, index]))
    return sessions
      .map((session, sourceIndex) => ({ session, sourceIndex, orderIndex: positions.get(session.name) }))
      .sort((left, right) => {
        if (left.orderIndex !== undefined || right.orderIndex !== undefined) {
          if (left.orderIndex === undefined) return 1
          if (right.orderIndex === undefined) return -1
          return left.orderIndex - right.orderIndex
        }
        return left.sourceIndex - right.sourceIndex
      })
      .map(item => item.session)
  }

  const loadDiscovery = useCallback(async (targetMux: TerminalMux) => {
    setDiscovery(previous => ({
      ...previous,
      mux: targetMux,
      loaded: previous.mux === targetMux && previous.loaded,
      unavailable: false,
    }))
    try {
      const response = await fetch(targetMux === 'herdr' ? '/api/herdr/list' : '/api/tmux/list', {
        signal: AbortSignal.timeout(3000),
      })
      if (!response.ok) throw new Error(await response.text())
      const data = targetMux === 'herdr'
        ? mapHerdrPayload(await response.json() as HerdrListPayload)
        : await response.json() as TmuxListPayload
      setDiscovery({
        mux: targetMux,
        projectGroups: data.projectGroups ?? [],
        otherSessions: data.otherSessions ?? [],
        currentSession: data.currentSession ?? null,
        loaded: true,
        unavailable: false,
      })
    } catch (error) {
      console.error(`[TmuxSidebar] ${targetMux} discovery failed:`, error)
      setDiscovery(previous => previous.mux === targetMux ? {
        ...previous,
        loaded: true,
        unavailable: true,
      } : previous)
    }
  }, [])

  useEffect(() => {
    setOptimisticSession(null)
    if (browserMux === mux) return
    void loadDiscovery(browserMux)
    const poll = window.setInterval(() => { void loadDiscovery(browserMux) }, DISCOVERY_POLL_INTERVAL)
    return () => window.clearInterval(poll)
  }, [browserMux, loadDiscovery, mux])

  useEffect(() => {
    if (switchingSession && paneId === switchingSession) {
      switchingSessionRef.current = null
      setSwitchingSession(null)
      setOptimisticSession(null)
    }
  }, [paneId, switchingSession])

  useEffect(() => {
    const sources = [
      ...sourceProjectGroups.map(group => ({ key: group.projectRoot, names: group.sessions.map(session => session.name) })),
      { key: '__other__', names: sourceOtherSessions.map(session => session.name) },
    ]
    setSessionOrder(previous => {
      let changed = false
      const next = { ...previous }
      for (const source of sources) {
        const key = sessionGroupKey(source.key)
        const existing = previous[key] ?? []
        const names = new Set(source.names)
        const merged = [
          ...existing.filter(name => names.has(name)),
          ...source.names.filter(name => !existing.includes(name)),
        ]
        if (merged.length !== existing.length || merged.some((name, index) => name !== existing[index])) {
          next[key] = merged
          changed = true
        }
      }
      if (changed) localStorage.setItem(SESSION_ORDER_KEY, JSON.stringify(next))
      return changed ? next : previous
    })
  }, [browserMux, sourceOtherSessions, sourceProjectGroups])

  const sortedGroups = useMemo(() => {
    const order = new Map(groupOrder.map((projectRoot, index) => [projectRoot, index]))
    return [...sourceProjectGroups].sort((left, right) => {
      const leftIndex = order.get(left.projectRoot)
      const rightIndex = order.get(right.projectRoot)
      if (leftIndex !== undefined || rightIndex !== undefined) {
        if (leftIndex === undefined) return 1
        if (rightIndex === undefined) return -1
        return leftIndex - rightIndex
      }
      return left.projectRoot.localeCompare(right.projectRoot)
    })
  }, [sourceProjectGroups, groupOrder])

  const query = search.trim().toLocaleLowerCase()
  const matches = (session: DiscoveredTmuxSession, group?: TmuxProjectGroup) => !query || [
    group?.displayName,
    group?.projectRoot,
    session.name,
    session.command,
    session.relativePath,
    session.path,
  ].some(value => value?.toLocaleLowerCase().includes(query))

  const toggleGroup = (key: string) => {
    setCollapsedGroups(previous => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...next]))
      return next
    })
  }

  const reorderGroup = (targetRoot: string, placeAfter: boolean) => {
    if (!draggedGroup || draggedGroup === targetRoot) return
    const next = sortedGroups.map(group => group.projectRoot).filter(projectRoot => projectRoot !== draggedGroup)
    const targetIndex = next.indexOf(targetRoot)
    next.splice(targetIndex + (placeAfter ? 1 : 0), 0, draggedGroup)
    setGroupOrder(next)
    localStorage.setItem(GROUP_ORDER_KEY, JSON.stringify(next))
  }

  const finishGroupDrag = () => {
    setDraggedGroup(null)
    setDragOverGroup(null)
  }

  const reorderSession = (groupKey: string, targetName: string, placeAfter: boolean) => {
    if (!draggedSession || draggedSession.groupKey !== groupKey || draggedSession.name === targetName) return
    const sourceSessions = groupKey === '__other__'
      ? sourceOtherSessions
      : sourceProjectGroups.find(group => group.projectRoot === groupKey)?.sessions ?? []
    const next = orderSessions(sourceSessions, groupKey)
      .map(session => session.name)
      .filter(name => name !== draggedSession.name)
    const targetIndex = next.indexOf(targetName)
    if (targetIndex < 0) return
    next.splice(targetIndex + (placeAfter ? 1 : 0), 0, draggedSession.name)
    const key = sessionGroupKey(groupKey)
    setSessionOrder(previous => {
      const updated = { ...previous, [key]: next }
      localStorage.setItem(SESSION_ORDER_KEY, JSON.stringify(updated))
      return updated
    })
  }

  const moveSessionByOffset = (name: string, offset: -1 | 1) => {
    const group = sourceProjectGroups.find(candidate => candidate.sessions.some(session => session.name === name))
    const groupKey = group?.projectRoot ?? '__other__'
    const sourceSessions = group?.sessions ?? sourceOtherSessions
    const next = orderSessions(sourceSessions, groupKey).map(session => session.name)
    const currentIndex = next.indexOf(name)
    const targetIndex = currentIndex + offset
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= next.length) return
    const displaced = next[targetIndex]
    next[targetIndex] = next[currentIndex]
    next[currentIndex] = displaced
    const key = sessionGroupKey(groupKey)
    setSessionOrder(previous => {
      const updated = { ...previous, [key]: next }
      localStorage.setItem(SESSION_ORDER_KEY, JSON.stringify(updated))
      return updated
    })
  }

  const getSessionPosition = (name: string) => {
    const group = sourceProjectGroups.find(candidate => candidate.sessions.some(session => session.name === name))
    const groupKey = group?.projectRoot ?? '__other__'
    const ordered = orderSessions(group?.sessions ?? sourceOtherSessions, groupKey)
    return { index: ordered.findIndex(session => session.name === name), count: ordered.length }
  }

  const finishSessionDrag = () => {
    setDraggedSession(null)
    setDragOverSession(null)
  }

  const switchSession = async (sessionName: string) => {
    if (longPressTriggered.current || sessionName === selectedSession) return
    const previous = sourceCurrentSession
    if (browserMux === 'herdr') {
      switchingSessionRef.current = sessionName
      setSwitchingSession(sessionName)
      setOptimisticSession(sessionName)
      if (mobile) onClose()
      switchTerminal('herdr', sessionName)
      return
    }
    if (switchingSessionRef.current) return
    switchingSessionRef.current = sessionName
    setSwitchingSession(sessionName)
    setOptimisticSession(sessionName)
    try {
      if (mux !== 'tmux') {
        sessionStorage.setItem('ttyd_last_tmux_session', sessionName)
        if (mobile) onClose()
        switchTerminal('tmux')
        return
      }
      if (!clientTty) throw new Error('No client tty')
      const url = `/api/tmux/switch?session=${encodeURIComponent(sessionName)}&client_tty=${encodeURIComponent(clientTty)}`
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (!response.ok) throw new Error(await response.text())
      sessionStorage.setItem('ttyd_last_tmux_session', sessionName)
      if (mobile) onClose()
      window.setTimeout(refresh, 300)
    } catch (error) {
      console.error('[TmuxSidebar] Switch failed:', error)
      setOptimisticSession(previous)
      if (mux !== 'tmux') return
      sendInput(` tmux attach -t ${shellQuote(sessionName)}\r`)
      sessionStorage.setItem('ttyd_last_tmux_session', sessionName)
      window.setTimeout(refresh, 500)
    } finally {
      if (switchingSessionRef.current === sessionName) switchingSessionRef.current = null
      setSwitchingSession(null)
    }
  }

  const killSession = async () => {
    if (!killTarget) return
    try {
      const url = browserMux === 'herdr'
        ? `/api/herdr/close?pane=${encodeURIComponent(killTarget)}`
        : `/api/tmux/kill?name=${encodeURIComponent(killTarget)}`
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error(await response.text())
      if (browsingConnectedMux) refresh()
      else void loadDiscovery(browserMux)
    } catch (error) {
      console.error('[TmuxSidebar] Kill failed:', error)
    } finally {
      setKillTarget(null)
    }
  }

  const detach = async () => {
    if (!browsingConnectedMux) return
    try {
      if (mux === 'herdr') {
        if (!paneId) throw new Error('No herdr pane')
        const response = await fetch(`/api/herdr/release?pane=${encodeURIComponent(paneId)}`, { signal: AbortSignal.timeout(3000) })
        if (!response.ok) throw new Error(await response.text())
        if (mobile) onClose()
        return
      }
      if (!clientTty) throw new Error('No client tty')
      const response = await fetch(`/api/tmux/detach?client_tty=${encodeURIComponent(clientTty)}`, { signal: AbortSignal.timeout(3000) })
      if (!response.ok) throw new Error(await response.text())
    } catch (error) {
      console.error('[TmuxSidebar] Detach failed:', error)
      if (mux === 'herdr') return
      sendInput(' tmux detach\r')
    }
    if (mobile) onClose()
    window.setTimeout(refresh, 500)
  }

  const quickShell = async () => {
    if (!browsingConnectedMux || (mux === 'herdr' ? !paneId : !clientTty)) return
    setQuickShellLoading(true)
    try {
      const url = mux === 'herdr'
        ? `/api/herdr/quick-shell?pane=${encodeURIComponent(paneId ?? '')}${path ? `&cwd=${encodeURIComponent(path)}` : ''}`
        : `/api/tmux/quick-shell?client_tty=${encodeURIComponent(clientTty ?? '')}`
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (!response.ok) throw new Error(await response.text())
      if (mobile) onClose()
      if (mux === 'herdr') {
        const data = await response.json() as { paneId?: string }
        if (!data.paneId) throw new Error('Herdr did not return the new pane id')
        switchTerminal('herdr', data.paneId)
        return
      }
      window.setTimeout(refresh, 300)
    } catch (error) {
      console.error('[TmuxSidebar] Quick Shell failed:', error)
    } finally {
      setQuickShellLoading(false)
    }
  }

  const startLongPress = (name: string) => {
    longPressTriggered.current = false
    longPressTimer.current = window.setTimeout(() => {
      longPressTriggered.current = true
      setKillTarget(name)
    }, LONG_PRESS_DURATION)
  }

  const endLongPress = () => {
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current)
    longPressTimer.current = null
    window.setTimeout(() => { longPressTriggered.current = false }, 0)
  }

  const renderSession = (session: DiscoveredTmuxSession, groupKey: string) => {
    const current = session.name === selectedSession
    const agentStatus = session.agentStatus ?? 'unknown'
    const agentStyle = AGENT_STATUS_STYLE[agentStatus]
    const dragging = draggedSession?.groupKey === groupKey && draggedSession.name === session.name
    const dragOver = dragOverSession?.groupKey === groupKey && dragOverSession.name === session.name
    return (
      <div
        key={session.name}
        data-session-name={session.name}
        data-session-group={groupKey}
        onDragOver={event => {
          if (!draggedSession || draggedSession.groupKey !== groupKey || search) return
          event.preventDefault()
          setDragOverSession({ groupKey, name: session.name })
        }}
        onDrop={event => {
          event.preventDefault()
          const bounds = event.currentTarget.getBoundingClientRect()
          reorderSession(groupKey, session.name, event.clientY > bounds.top + bounds.height / 2)
          finishSessionDrag()
        }}
        className={`group flex items-stretch rounded-lg transition-colors ${current ? 'bg-accent-purple/20' : dragOver ? 'bg-accent-purple/10' : 'hover:bg-bg-tertiary'} ${dragging ? 'opacity-50' : ''}`}
      >
        <span
          draggable={!search && !sessionSwitchLocked}
          onDragStart={() => {
            setDraggedSession({ groupKey, name: session.name })
            setDragOverSession({ groupKey, name: session.name })
          }}
          onDragEnd={finishSessionDrag}
          onKeyDown={event => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            moveSessionByOffset(session.name, event.key === 'ArrowUp' ? -1 : 1)
          }}
          role="button"
          tabIndex={0}
          aria-label={`Move ${session.name} ${browserMux === 'herdr' ? 'pane' : 'session'}`}
          title={search ? 'Clear search to reorder' : `Drag to reorder ${browserMux === 'herdr' ? 'pane' : 'session'}`}
          className={`self-stretch px-1.5 py-3 text-[10px] text-text-muted select-none ${search || sessionSwitchLocked ? 'cursor-not-allowed opacity-40' : 'cursor-grab active:cursor-grabbing'}`}
        >⋮⋮</span>
        <button
          onClick={() => { void switchSession(session.name) }}
          onTouchStart={() => startLongPress(session.name)}
          onTouchEnd={endLongPress}
          onMouseDown={() => startLongPress(session.name)}
          onMouseUp={endLongPress}
          onMouseLeave={endLongPress}
          disabled={sessionSwitchLocked}
          className="min-w-0 flex-1 px-2 py-2 text-left disabled:cursor-wait"
          aria-current={current ? 'page' : undefined}
          aria-busy={switchingSession === session.name ? true : undefined}
          data-agent-status={browserMux === 'herdr' ? agentStatus : undefined}
        >
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${browserMux === 'herdr' ? agentStyle.dot : session.hasNewActivity ? 'bg-accent-orange animate-pulse' : session.attached ? 'bg-accent-green' : 'bg-text-muted'}`} />
            <span className={`truncate text-sm font-medium ${current ? 'text-accent-purple' : 'text-text-primary'}`}>{session.name}</span>
            {browserMux === 'herdr' ? (
              <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${agentStyle.badge}`}>{agentStyle.label}</span>
            ) : (
              <span className="ml-auto shrink-0 text-[10px] text-text-muted">{session.windows}w</span>
            )}
          </div>
          <div className="mt-1 flex gap-2 pl-4 text-[11px] text-text-muted">
            <span className="truncate" title={session.path}>{session.relativePath}</span>
            <span className="ml-auto shrink-0 font-mono">{session.command}</span>
          </div>
        </button>
        <button
          onClick={() => setKillTarget(session.name)}
          disabled={sessionSwitchLocked}
          className="px-2 text-text-muted hover:text-accent-red"
          aria-label={`${browserMux === 'herdr' ? 'Pane' : 'Session'} actions for ${session.name}`}
        >
          ⋯
        </button>
      </div>
    )
  }

  const visibleGroups = sortedGroups
    .map(group => ({ ...group, sessions: orderSessions(group.sessions.filter(session => matches(session, group)), group.projectRoot) }))
    .filter(group => group.sessions.length > 0 || (browserMux === 'herdr' && (!query || [group.displayName, group.projectRoot].some(value => value.toLocaleLowerCase().includes(query)))))
  const visibleOther = orderSessions(sourceOtherSessions.filter(session => matches(session)), '__other__')
  const empty = visibleGroups.length === 0 && visibleOther.length === 0

  return (
    <aside className="flex h-full w-[280px] flex-col border-r border-border-subtle bg-bg-secondary text-text-primary">
      <div className="border-b border-border-subtle p-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold">Workspaces</span>
          <button
            onClick={() => browsingConnectedMux ? refresh() : void loadDiscovery(browserMux)}
            className="ml-auto rounded px-2 py-1 text-text-muted hover:bg-bg-tertiary"
            aria-label={`Refresh ${browserMux} workspaces`}
          >↻</button>
          <button onClick={mobile ? onClose : onCollapseDesktop} className="rounded px-2 py-1 text-text-muted hover:bg-bg-tertiary" aria-label="Close sessions sidebar">×</button>
        </div>
        <div className="mt-3 grid grid-cols-2 rounded-lg bg-bg-primary p-1" role="tablist" aria-label="Workspace source">
          {(['tmux', 'herdr'] as const).map(source => (
            <button
              key={source}
              type="button"
              role="tab"
              aria-selected={browserMux === source}
              onClick={() => setBrowserMux(source)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${browserMux === source ? 'bg-accent-purple text-white' : 'text-text-muted hover:text-text-primary'}`}
            >{source === 'tmux' ? 'tmux' : 'Herdr'}</button>
          ))}
        </div>
      </div>
      <div className="p-3">
        <input
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder={browserMux === 'herdr' ? 'Search workspaces or panes' : 'Search projects or sessions'}
          className="w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm outline-none focus:border-accent-purple"
        />
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {!browsingConnectedMux && (
          <div className="mx-1 mb-3 rounded-lg border border-accent-purple/30 bg-accent-purple/10 px-3 py-2 text-xs text-text-secondary">
            Choose a {browserMux === 'herdr' ? 'Herdr pane' : 'tmux session'} to connect. Your current terminal stays open until then.
          </div>
        )}
        {visibleGroups.map(group => {
          const active = group.sessions.some(session => session.name === selectedSession)
          return (
          <section
            key={group.projectRoot}
            data-project-root={group.projectRoot}
            data-active-project={active ? 'true' : undefined}
            onDragOver={event => {
              if (!draggedGroup || search) return
              event.preventDefault()
              setDragOverGroup(group.projectRoot)
            }}
            onDrop={event => {
              event.preventDefault()
              const bounds = event.currentTarget.getBoundingClientRect()
              reorderGroup(group.projectRoot, event.clientY > bounds.top + bounds.height / 2)
              finishGroupDrag()
            }}
            className={`mb-2 rounded-xl border transition-colors ${
              active
                ? 'border-accent-purple/50 bg-accent-purple/10 shadow-[inset_3px_0_0_var(--accent-purple)]'
                : dragOverGroup === group.projectRoot
                  ? 'border-accent-purple/50 bg-accent-purple/5'
                  : 'border-transparent'
            } ${draggedGroup === group.projectRoot ? 'opacity-50' : ''}`}
          >
            <div className="flex items-center">
              <span
                draggable={!search}
                onDragStart={() => {
                  setDraggedGroup(group.projectRoot)
                  setDragOverGroup(group.projectRoot)
                }}
                onDragEnd={finishGroupDrag}
                role="button"
                tabIndex={0}
                aria-label={`Move ${group.displayName} project`}
                title={search ? 'Clear search to reorder projects' : 'Drag to reorder project'}
                className={`ml-1 px-1.5 py-2 text-xs text-text-muted select-none ${search ? 'cursor-not-allowed opacity-40' : 'cursor-grab active:cursor-grabbing'}`}
              >
                ⋮⋮
              </span>
              <button onClick={() => toggleGroup(group.projectRoot)} className="flex min-w-0 flex-1 items-center gap-2 px-1 py-2 text-left text-xs font-semibold text-text-secondary">
                <span>{collapsedGroups.has(group.projectRoot) ? '▸' : '▾'}</span>
                <span className={`truncate ${active ? 'text-accent-purple' : ''}`} title={group.projectRoot}>{group.displayName}</span>
                <span className="ml-auto pr-2 text-text-muted">{group.sessions.length}</span>
              </button>
            </div>
            {!collapsedGroups.has(group.projectRoot) && (
              <div className="space-y-1">
                {group.sessions.map(session => renderSession(session, group.projectRoot))}
                {group.sessions.length === 0 && <div className="px-3 pb-2 text-xs text-text-muted">No panes</div>}
              </div>
            )}
          </section>
          )
        })}
        {visibleOther.length > 0 && (
          <section>
            <button onClick={() => toggleGroup('__other__')} className="flex w-full items-center gap-2 px-2 py-2 text-left text-xs font-semibold text-text-secondary">
              <span>{collapsedGroups.has('__other__') ? '▸' : '▾'}</span>
              <span>Other</span>
              <span className="ml-auto text-text-muted">{visibleOther.length}</span>
            </button>
            {!collapsedGroups.has('__other__') && <div className="space-y-1">{visibleOther.map(session => renderSession(session, '__other__'))}</div>}
          </section>
        )}
        {sourceUnavailable ? (
          <div className="mx-1 rounded-lg border border-accent-red/30 bg-accent-red/10 px-3 py-4 text-center text-sm">
            <p className="font-medium text-accent-red">{browserMux === 'herdr' ? 'Herdr server unavailable' : 'tmux discovery unavailable'}</p>
            {browserMux === 'herdr' && <p className="mt-1 text-xs text-text-muted">Run <span className="font-mono">herdr server</span>, then retry.</p>}
            <button onClick={() => browsingConnectedMux ? refresh() : void loadDiscovery(browserMux)} className="mt-3 rounded-md bg-bg-tertiary px-3 py-1.5 text-xs">Retry</button>
          </div>
        ) : empty && (
          <div className="px-3 py-8 text-center text-sm text-text-muted">
            {sourceLoaded ? (search ? 'No matching sessions' : browserMux === 'herdr' ? 'No Herdr workspaces or panes' : 'No tmux sessions') : `Loading ${browserMux === 'herdr' ? 'Herdr workspaces' : 'tmux sessions'}…`}
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 border-t border-border-subtle p-3 text-xs">
        <button
          onClick={() => setIsNewSessionOpen(true)}
          disabled={browserMux === 'tmux' && mux !== 'tmux'}
          className="rounded-lg bg-accent-purple px-2 py-2 text-white disabled:opacity-50"
          title={browserMux === 'tmux' && mux !== 'tmux' ? 'Choose a tmux session first' : undefined}
        >{browserMux === 'herdr' ? '+ New Workspace' : '+ New Session'}</button>
        <button onClick={() => { void quickShell() }} disabled={!browsingConnectedMux || (mux === 'herdr' ? !paneId : !clientTty) || quickShellLoading} className="rounded-lg bg-bg-tertiary px-2 py-2 disabled:opacity-50">{quickShellLoading ? 'Opening…' : 'Quick Shell'}</button>
        <button onClick={() => { void detach() }} disabled={!browsingConnectedMux} className="col-span-2 rounded-lg bg-bg-tertiary px-2 py-2 text-text-secondary disabled:opacity-50">Detach to Shell</button>
      </div>
      <NewSessionModal isOpen={isNewSessionOpen} onClose={() => setIsNewSessionOpen(false)} cwd={path || undefined} onCreated={() => browsingConnectedMux ? refresh() : void loadDiscovery(browserMux)} targetMux={browserMux} />
      {killTarget && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4" onClick={event => event.target === event.currentTarget && setKillTarget(null)}>
          <div className="w-full max-w-sm rounded-xl bg-bg-secondary p-4">
            <h3 className="text-lg font-semibold">{browserMux === 'herdr' ? 'Pane Actions' : 'Session Actions'}</h3>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                onClick={() => moveSessionByOffset(killTarget, -1)}
                disabled={getSessionPosition(killTarget).index <= 0}
                className="rounded-lg bg-bg-tertiary px-3 py-2 text-sm disabled:opacity-40"
              >Move Up</button>
              <button
                onClick={() => moveSessionByOffset(killTarget, 1)}
                disabled={getSessionPosition(killTarget).index >= getSessionPosition(killTarget).count - 1}
                className="rounded-lg bg-bg-tertiary px-3 py-2 text-sm disabled:opacity-40"
              >Move Down</button>
            </div>
            <p className="my-4 text-sm text-text-secondary">{browserMux === 'herdr' ? 'Close' : 'Kill'} <span className="font-mono text-accent-red">{killTarget}</span>? This cannot be undone.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setKillTarget(null)} className="rounded-lg bg-bg-tertiary px-4 py-2">Cancel</button>
              <button onClick={() => { void killSession() }} className="rounded-lg bg-accent-red px-4 py-2 text-white">{browserMux === 'herdr' ? 'Close Pane' : 'Kill Session'}</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
