import React, { useState, useEffect, useCallback } from 'react'
import { Toolbar } from './Toolbar'
import { StatusBar } from './StatusBar'
import { ActivityStream } from './ActivityStream'
import { ConnectionOverlay } from './ConnectionOverlay'
import { useTerminal } from '../contexts/TerminalContext'

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { terminalRef } = useTerminal()
  const [viewportHeight, setViewportHeight] = useState<number | null>(null)

  const updateHeight = useCallback(() => {
    const vv = window.visualViewport
    if (vv) {
      setViewportHeight(vv.height)
    }
  }, [])

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    vv.addEventListener('resize', updateHeight)
    vv.addEventListener('scroll', updateHeight)
    updateHeight()

    return () => {
      vv.removeEventListener('resize', updateHeight)
      vv.removeEventListener('scroll', updateHeight)
    }
  }, [updateHeight])

  const heightStyle = viewportHeight ? { height: `${viewportHeight}px` } : { height: '100dvh' }

  return (
    <div
      className="flex flex-col bg-bg-primary overflow-hidden text-text-primary font-sans selection:bg-accent-blue/30"
      style={heightStyle}
    >
      <StatusBar />

      <ActivityStream />

      <div 
        ref={terminalRef} 
        className="flex-1 min-h-0 relative bg-bg-primary overflow-hidden"
      >
        {children}
      </div>

      <Toolbar />

      <ConnectionOverlay />
    </div>
  )
}
