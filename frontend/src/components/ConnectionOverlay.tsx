import React, { useEffect, useCallback } from 'react'
import { useTerminal } from '../contexts/TerminalContext'

export const ConnectionOverlay: React.FC = () => {
  const { connectionState, reconnect, reconnectAttempt } = useTerminal()

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' && connectionState === 'disconnected') {
      reconnect()
    }
  }, [connectionState, reconnect])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  if (connectionState === 'connected') return null

  const isReconnecting = connectionState === 'reconnecting'
  const isConnecting = connectionState === 'connecting'
  const isDisconnected = connectionState === 'disconnected'

  return (
    <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center pointer-events-auto">
      <div className="bg-bg-secondary rounded-xl p-6 max-w-xs w-full mx-4 text-center shadow-xl border border-border-subtle">
        {(isConnecting || isReconnecting) && (
          <>
            <div className="w-8 h-8 border-2 border-accent-purple border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">
              {isReconnecting ? 'Reconnecting...' : 'Connecting...'}
            </h3>
            {isReconnecting && (
              <p className="text-sm text-text-secondary">
                Attempt {reconnectAttempt} of 10
              </p>
            )}
          </>
        )}

        {isDisconnected && reconnectAttempt >= 10 && (
          <>
            <div className="w-12 h-12 rounded-full bg-accent-red/20 flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">✕</span>
            </div>
            <h3 className="text-lg font-semibold mb-2">Connection Failed</h3>
            <p className="text-sm text-text-secondary mb-4">
              Could not connect after 10 attempts
            </p>
            <button
              onClick={reconnect}
              className="w-full py-2.5 bg-accent-purple text-white rounded-lg font-medium active:opacity-80"
            >
              Try Again
            </button>
          </>
        )}

        {isDisconnected && reconnectAttempt < 10 && reconnectAttempt > 0 && (
          <>
            <div className="w-12 h-12 rounded-full bg-accent-yellow/20 flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">⚡</span>
            </div>
            <h3 className="text-lg font-semibold mb-2">Disconnected</h3>
            <p className="text-sm text-text-secondary mb-4">
              Reconnecting automatically...
            </p>
            <button
              onClick={reconnect}
              className="w-full py-2.5 bg-accent-purple text-white rounded-lg font-medium active:opacity-80"
            >
              Reconnect Now
            </button>
            <p className="text-xs text-text-muted mt-3">
              or press Enter
            </p>
          </>
        )}

        {isDisconnected && reconnectAttempt === 0 && (
          <>
            <div className="w-12 h-12 rounded-full bg-accent-yellow/20 flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">⚡</span>
            </div>
            <h3 className="text-lg font-semibold mb-2">Disconnected</h3>
            <p className="text-sm text-text-secondary mb-4">
              Connection lost
            </p>
            <button
              onClick={reconnect}
              className="w-full py-2.5 bg-accent-purple text-white rounded-lg font-medium active:opacity-80"
            >
              Reconnect
            </button>
            <p className="text-xs text-text-muted mt-3">
              or press Enter
            </p>
          </>
        )}
      </div>
    </div>
  )
}
