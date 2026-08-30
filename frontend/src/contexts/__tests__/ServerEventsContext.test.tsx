import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServerEventsProvider, useServerEvents } from '../ServerEventsContext'

const terminalState: { clientTty: string | null; mux: 'tmux' | 'herdr'; paneId: string | null } = {
  clientTty: '/dev/ttys001',
  mux: 'tmux',
  paneId: null,
}

vi.mock('../TerminalContext', () => ({ useTerminal: () => terminalState }))

class EventSourceMock {
  static instances: EventSourceMock[] = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  close = vi.fn()
  constructor(public readonly url: string) { EventSourceMock.instances.push(this) }
}

const Probe = () => {
  const { sessionsLoaded, projectGroups, isOffline, tuiActive } = useServerEvents()
  const status = projectGroups[0]?.sessions[0]?.agentStatus
  return <div data-tui-active={tuiActive ? 'true' : 'false'}>{sessionsLoaded ? 'loaded' : 'loading'}:{projectGroups.length}:{isOffline ? 'offline' : 'online'}{status ? `:${status}` : ''}</div>
}

describe('ServerEventsProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    terminalState.clientTty = '/dev/ttys001'
    terminalState.mux = 'tmux'
    terminalState.paneId = null
    EventSourceMock.instances = []
    vi.stubGlobal('EventSource', EventSourceMock)
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/diff')) return Promise.resolve(new Response(JSON.stringify({ branch: 'main', git_root: '/repo' })))
      if (url.startsWith('/api/tmux/pane-mode')) return Promise.resolve(new Response(JSON.stringify({ tuiActive: false })))
      return Promise.resolve(new Response(JSON.stringify({ sessions: [], currentSession: null, scannedAt: 1, projectGroups: [], otherSessions: [] })))
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('handles an empty snapshot, falls back to polling, and reconnects SSE', async () => {
    render(<ServerEventsProvider><Probe /></ServerEventsProvider>)
    await waitFor(() => expect(screen.getByText('loaded:0:online')).toBeInTheDocument())
    expect(EventSourceMock.instances).toHaveLength(1)
    expect(EventSourceMock.instances[0].url).toContain('client_tty=%2Fdev%2Fttys001')

    act(() => { EventSourceMock.instances[0].onerror?.(new Event('error')) })
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/diff', expect.anything()))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(EventSourceMock.instances).toHaveLength(2)
    act(() => { EventSourceMock.instances[1].onopen?.(new Event('open')) })
    expect(EventSourceMock.instances[0].close).toHaveBeenCalled()
  })

  it('applies realtime herdr status and notifies once when work becomes idle', async () => {
    terminalState.clientTty = null
    terminalState.mux = 'herdr'
    terminalState.paneId = 'w4:p1'
    const notifications: Array<{ title: string; body?: string }> = []
    class NotificationMock {
      static permission = 'granted'
      constructor(title: string, options?: NotificationOptions) {
        notifications.push({ title, body: options?.body })
      }
    }
    vi.stubGlobal('Notification', NotificationMock)
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/diff')) return Promise.resolve(new Response(JSON.stringify({ branch: '', cwd: '/tmp' })))
      return Promise.resolve(new Response(JSON.stringify({
        panes: [{ pane_id: 'w4:p1', workspace_id: 'w4', cwd: '/tmp', agent_status: 'working' }],
        workspaces: [{ workspace_id: 'w4', label: 'test' }],
        agents: [{ pane_id: 'w4:p1', agent: 'claude', agent_status: 'working' }],
      })))
    }))

    render(<ServerEventsProvider><Probe /></ServerEventsProvider>)
    await waitFor(() => expect(screen.getByText('loaded:1:online:working')).toBeInTheDocument())
    expect(screen.getByText('loaded:1:online:working')).toHaveAttribute('data-tui-active', 'true')
    expect(EventSourceMock.instances[0].url).toContain('mux=herdr')
    act(() => {
      EventSourceMock.instances[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify({
        herdr: {
          panes: [{ pane_id: 'w4:p1', workspace_id: 'w4', cwd: '/tmp', agent_status: 'idle' }],
          workspaces: [{ workspace_id: 'w4', label: 'test' }],
          agents: [{ pane_id: 'w4:p1', agent: 'claude', agent_status: 'idle' }],
        },
      }) }))
    })
    await waitFor(() => expect(screen.getByText('loaded:1:online:idle')).toBeInTheDocument())
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(notifications).toEqual([{ title: 'Rust Terminal agent update', body: 'w4:p1 is idle' }])
  })
})
