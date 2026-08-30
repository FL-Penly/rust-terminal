import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TmuxSidebar } from '../TmuxSidebar'

const sendInput = vi.fn()
const refresh = vi.fn()
const switchTerminal = vi.fn()
const terminalState = { sendInput, switchTerminal, mux: 'tmux' as const, paneId: null }
const serverState = {
  projectGroups: [
    {
      projectRoot: '/work/beta',
      displayName: 'beta',
      sessions: [
        { name: 'idle', path: '/work/beta', relativePath: '.', command: 'zsh', attached: false, windows: 1, lastActivity: 10, hasNewActivity: false },
      ],
    },
    {
      projectRoot: '/work/alpha',
      displayName: 'alpha',
      sessions: [
        { name: 'active-news', path: '/work/alpha/web', relativePath: 'web', command: 'node', attached: true, windows: 2, lastActivity: 30, hasNewActivity: true },
        { name: 'current', path: '/work/alpha', relativePath: '.', command: 'codex', attached: true, windows: 3, lastActivity: 20, hasNewActivity: false },
      ],
    },
  ],
  otherSessions: [
    { name: 'loose', path: '/tmp', relativePath: '/tmp', command: 'bash', attached: false, windows: 1, lastActivity: 5, hasNewActivity: false },
  ],
  currentTmuxSession: 'current',
  clientTty: '/dev/ttys001',
  path: '/work/alpha',
  isOffline: false,
  sessionsLoaded: true,
  refresh,
}

vi.mock('../../contexts/TerminalContext', () => ({ useTerminal: () => terminalState }))
vi.mock('../../contexts/ServerEventsContext', () => ({ useServerEvents: () => serverState }))

describe('TmuxSidebar', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    sendInput.mockReset()
    switchTerminal.mockReset()
    refresh.mockReset()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('keeps persisted project order, highlights the active project, and preserves session order', () => {
    localStorage.setItem('tmux_sidebar_group_order', JSON.stringify(['/work/beta', '/work/alpha']))
    render(<TmuxSidebar mobile={false} onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)
    const headings = screen.getAllByRole('button').filter(button => ['alpha', 'beta', 'Other'].some(label => button.textContent?.includes(label)))
    expect(headings.map(button => button.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('alpha'), expect.stringContaining('beta'), expect.stringContaining('Other')]))
    const names = ['active-news', 'current', 'idle', 'loose'].map(name => screen.getByText(name))
    expect(names[0].compareDocumentPosition(names[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('beta').compareDocumentPosition(screen.getByText('alpha')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('beta').compareDocumentPosition(screen.getByText('Other')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('alpha').closest('section')).toHaveAttribute('data-active-project', 'true')
    expect(screen.getByText('current').closest('button')).toHaveAttribute('aria-current', 'page')
  })

  it('reorders project groups by drag and persists the new order', () => {
    render(<TmuxSidebar mobile={false} onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)
    const alphaSection = screen.getByText('alpha').closest('section')
    expect(alphaSection).not.toBeNull()
    fireEvent.dragStart(screen.getByRole('button', { name: 'Move beta project' }))
    fireEvent.dragOver(alphaSection as HTMLElement)
    fireEvent.drop(alphaSection as HTMLElement, { clientY: 0 })
    expect(screen.getByText('beta').compareDocumentPosition(screen.getByText('alpha')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('tmux_sidebar_group_order') ?? '[]')).toEqual(['/work/beta', '/work/alpha'])
  })

  it('reorders sessions only when the user drags them and persists the fixed order', () => {
    render(<TmuxSidebar mobile={false} onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)
    const activeDropRow = screen.getByText('active-news').closest('[data-session-name]')
    expect(activeDropRow).not.toBeNull()

    fireEvent.dragStart(screen.getByRole('button', { name: 'Move current session' }))
    fireEvent.dragOver(activeDropRow as HTMLElement)
    fireEvent.drop(activeDropRow as HTMLElement, { clientY: 0 })

    const currentRow = document.querySelector('[data-session-name="current"]')
    const activeRow = document.querySelector('[data-session-name="active-news"]')
    expect(currentRow).not.toBeNull()
    expect(activeRow).not.toBeNull()
    expect((currentRow as HTMLElement).compareDocumentPosition(activeRow as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('tmux_sidebar_session_order') ?? '{}')).toMatchObject({
      'tmux:/work/alpha': ['current', 'active-news'],
    })
  })

  it('also exposes move controls in the session actions menu for touch users', async () => {
    const user = userEvent.setup()
    render(<TmuxSidebar mobile onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)

    await user.click(screen.getByLabelText('Session actions for current'))
    expect(screen.getByText('Session Actions')).toBeInTheDocument()
    await user.click(screen.getByText('Move Up'))

    const currentRow = document.querySelector('[data-session-name="current"]')
    const activeRow = document.querySelector('[data-session-name="active-news"]')
    expect(currentRow).not.toBeNull()
    expect(activeRow).not.toBeNull()
    expect((currentRow as HTMLElement).compareDocumentPosition(activeRow as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('searches all session metadata and persists group collapse', async () => {
    const user = userEvent.setup()
    render(<TmuxSidebar mobile={false} onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)
    await user.type(screen.getByPlaceholderText('Search projects or sessions'), 'node')
    expect(screen.getByText('active-news')).toBeInTheDocument()
    expect(screen.queryByText('idle')).not.toBeInTheDocument()
    await user.clear(screen.getByPlaceholderText('Search projects or sessions'))
    await user.click(screen.getByText('alpha'))
    expect(screen.queryByText('current')).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('tmux_sidebar_collapsed_groups') ?? '[]')).toContain('/work/alpha')
  })

  it('switches using encoded session and tty then closes a mobile drawer', async () => {
    const onClose = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    render(<TmuxSidebar mobile onClose={onClose} onCollapseDesktop={vi.fn()} />)
    fireEvent.click(screen.getByText('idle'))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/tmux/switch?session=idle&client_tty=%2Fdev%2Fttys001',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))
    expect(onClose).toHaveBeenCalled()
    expect(sessionStorage.getItem('ttyd_last_tmux_session')).toBe('idle')
  })

  it('restores highlight and uses a safely quoted terminal fallback on switch failure', async () => {
    serverState.projectGroups[0].sessions[0].name = "bad'name"
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    render(<TmuxSidebar mobile={false} onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)
    fireEvent.click(screen.getByText("bad'name"))
    await waitFor(() => expect(sendInput).toHaveBeenCalledWith(" tmux attach -t 'bad'\"'\"'name'\r"))
    expect(screen.getByText('current').closest('button')).toHaveAttribute('aria-current', 'page')
    serverState.projectGroups[0].sessions[0].name = 'idle'
  })

  it('keeps new session, quick shell, detach, and kill actions available', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    render(<TmuxSidebar mobile={false} onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)
    await user.click(screen.getByText('+ New Session'))
    expect(screen.getByText('New Tmux Session')).toBeInTheDocument()
    await user.click(screen.getByText('Cancel'))
    await user.click(screen.getByText('Quick Shell'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/tmux/quick-shell?client_tty=%2Fdev%2Fttys001', expect.anything()))
    await user.click(screen.getByText('Detach to Shell'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/tmux/detach?client_tty=%2Fdev%2Fttys001', expect.anything()))
    await user.click(screen.getByLabelText('Session actions for idle'))
    await user.click(screen.getByText('Kill Session'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/tmux/kill?name=idle', expect.anything()))
  })

  it('discovers Herdr workspaces and panes from the visible source switcher', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      workspaces: [
        { workspace_id: 'w3', label: 'rust-terminal' },
        { workspace_id: 'w4', label: 'empty-workspace' },
      ],
      panes: [
        { pane_id: 'w3:p1', workspace_id: 'w3', foreground_cwd: '/work/rust-terminal', revision: 7 },
      ],
      agents: [
        { pane_id: 'w3:p1', agent: 'claude', agent_status: 'working' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    render(<TmuxSidebar mobile={false} onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)
    await user.click(screen.getByRole('tab', { name: 'Herdr' }))

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/herdr/list', expect.objectContaining({ signal: expect.any(AbortSignal) })))
    expect((await screen.findAllByText('rust-terminal')).length).toBeGreaterThan(0)
    expect(screen.getByText('w3:p1')).toBeInTheDocument()
    expect(screen.getByText('working')).toBeInTheDocument()
    expect(screen.getByText('empty-workspace')).toBeInTheDocument()
    expect(screen.getByText('No panes')).toBeInTheDocument()
    expect(screen.getByText(/Choose a Herdr pane to connect/)).toBeInTheDocument()
    expect(screen.getByText('+ New Workspace')).toBeInTheDocument()
  })

  it('accepts rapid Herdr clicks and forwards the latest target without blocking the list', async () => {
    const user = userEvent.setup()
    const listPayload = {
      workspaces: [{ workspace_id: 'w3', label: 'rust-terminal' }],
      panes: [
        { pane_id: 'w3:p1', workspace_id: 'w3', foreground_cwd: '/work/rust-terminal' },
        { pane_id: 'w3:p2', workspace_id: 'w3', foreground_cwd: '/work/rust-terminal' },
      ],
      agents: [],
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url === '/api/herdr/list') {
        return Promise.resolve(new Response(JSON.stringify(listPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }))
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })

    render(<TmuxSidebar mobile={false} onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)
    await user.click(screen.getByRole('tab', { name: 'Herdr' }))
    const firstPane = await screen.findByText('w3:p1')
    await user.click(firstPane)
    fireEvent.click(screen.getByText('w3:p2'))

    expect(firstPane.closest('button')).not.toBeDisabled()
    expect(screen.getByText('w3:p2').closest('button')).toHaveAttribute('aria-busy', 'true')
    expect(switchTerminal).toHaveBeenNthCalledWith(1, 'herdr', 'w3:p1')
    expect(switchTerminal).toHaveBeenNthCalledWith(2, 'herdr', 'w3:p2')
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/herdr/focus')).length).toBe(0)
  })

  it('shows an actionable Herdr unavailable state', async () => {
    const user = userEvent.setup()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unavailable', { status: 503 }))

    render(<TmuxSidebar mobile={false} onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)
    await user.click(screen.getByRole('tab', { name: 'Herdr' }))

    expect(await screen.findByText('Herdr server unavailable')).toBeInTheDocument()
    expect(screen.getByText('herdr server')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
