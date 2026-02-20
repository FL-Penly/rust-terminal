import React, { useCallback } from 'react'
import { useTerminal } from '../contexts/TerminalContext'
import { useServerEvents } from '../contexts/ServerEventsContext'
import { SessionTabBar } from './SessionTabBar'
import { BranchSelector } from './BranchSelector'

// Truncate path to max length
function truncatePath(path: string, maxLen: number = 20): string {
  if (path.length <= maxLen) return path
  const parts = path.split('/')
  if (parts.length <= 2) return '...' + path.slice(-maxLen + 3)
  return '~/' + parts.slice(-2).join('/')
}

export const StatusBar: React.FC = () => {
  const { connectionState } = useTerminal()
  const { branch, path, isOffline, refresh } = useServerEvents()

  const handleBranchChange = useCallback(() => {
    setTimeout(() => refresh(), 500)
  }, [refresh])

  const isConnected = connectionState === 'connected'

  return (
    <div className="h-[40px] shrink-0 border-b border-border-subtle flex items-center px-3 bg-bg-secondary overflow-visible">
      <div className="flex items-center gap-2 text-xs text-text-secondary font-mono w-full">
        <span 
          className={`w-2 h-2 rounded-full shrink-0 ${isConnected ? 'bg-accent-green' : 'bg-accent-red'}`}
          title={isConnected ? 'Connected' : 'Disconnected'}
        />
        
        <SessionTabBar />
        
        <span className="text-border-subtle shrink-0">│</span>
        
        {isOffline ? (
          <span className="text-text-muted">(offline)</span>
        ) : (
          <>
            <BranchSelector currentBranch={branch || '-'} onBranchChange={handleBranchChange} />
            <span className="text-border-subtle shrink-0">│</span>
            <span className="truncate" title={path}>{truncatePath(path)}</span>
          </>
        )}

      </div>
    </div>
  )
}
