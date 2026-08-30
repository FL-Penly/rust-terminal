import type { TerminalMux } from '../contexts/TerminalContext'

export const withTerminalTarget = (
  url: string,
  mux: TerminalMux,
  paneId: string | null,
  clientTty: string | null,
): string => {
  const [path, query = ''] = url.split('?', 2)
  const params = new URLSearchParams(query)

  if (mux === 'herdr') {
    params.set('mux', 'herdr')
    if (paneId) params.set('pane', paneId)
    else params.delete('pane')
    params.delete('client_tty')
  } else if (clientTty) {
    params.set('client_tty', clientTty)
  }

  const encoded = params.toString()
  return encoded ? `${path}?${encoded}` : path
}
