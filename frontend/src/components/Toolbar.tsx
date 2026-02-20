import React, { useState, useEffect, useRef } from 'react'
import { useTerminal } from '../contexts/TerminalContext'
import { SettingsModal, CommandConfig } from './SettingsModal'
import { TextInputModal } from './TextInputModal'
import { DiffViewer } from './DiffViewer'

const hapticTap = () => { try { navigator.vibrate?.(8) } catch {} }

export const Toolbar: React.FC = () => {
  const { sendKey, sendInput } = useTerminal()
  const [config, setConfig] = useState<CommandConfig | null>(null)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isInputOpen, setIsInputOpen] = useState(false)
  const [isDiffOpen, setIsDiffOpen] = useState(false)
  const [isExpanded, setIsExpanded] = useState(() => {
    const saved = localStorage.getItem('ttyd_toolbar_expanded')
    return saved !== 'false'
  })

  const toggleExpanded = () => {
    setIsExpanded(prev => {
      localStorage.setItem('ttyd_toolbar_expanded', String(!prev))
      return !prev
    })
  }

  const loadConfig = () => {
    const saved = localStorage.getItem('ttyd_commands')
    if (saved) {
      try {
        setConfig(JSON.parse(saved))
      } catch (e) {
        console.error('Failed to parse ttyd_commands', e)
      }
    } else {
      setConfig({
        defaultCommands: [
          { name: 'claude', cmd: 'claude --dangerously-skip-permissions', visible: true },
          { name: 'opencode', cmd: 'opencode', visible: true }
        ],
        customCommands: []
      })
    }
  }

  useEffect(() => {
    loadConfig()
  }, [])

  const handleCommand = (cmd: string) => {
    sendInput(cmd + '\r')
  }

  const k = (key: Parameters<typeof sendKey>[0]) => {
    hapticTap()
    sendKey(key)
  }

  const c = (cmd: string) => {
    hapticTap()
    handleCommand(cmd)
  }

  const fileInputRef = useRef<HTMLInputElement>(null)

   const handleImageUpload = async (file: File) => {
     try {
       const response = await fetch(`/api/upload-image`, {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: file,
      })
      if (!response.ok) throw new Error(`Upload failed: ${response.status}`)
      const { path } = await response.json()
      sendInput(path)
    } catch (err) {
      console.error('[Toolbar] Image upload failed:', err)
    }
  }

  return (
    <>
      <div className="bg-bg-secondary border-t border-border-subtle shrink-0 pb-[env(safe-area-inset-bottom)]">
        <div className="flex flex-col gap-1.5 px-2 py-1.5">

          {isExpanded ? (
            <>
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                <Toggle expanded onClick={toggleExpanded} />
                <K label="ESC" onClick={() => k('ESC')} />
                <K label="^C" onClick={() => k('CTRL_C')} className="text-accent-red" />
                <K label="^L" onClick={() => k('CTRL_L')} />
                <Sep />
                <CmdGroup config={config} onCmd={c} />
                <Sys label="⌨️" onClick={() => setIsInputOpen(true)} aria-label="Text input" />
                <Sys label="📷" onClick={() => fileInputRef.current?.click()} aria-label="Upload image" />
                <Sys label="Sel" onClick={() => { hapticTap(); window.dispatchEvent(new Event('terminal-copy-viewport')) }} className="text-accent-purple" aria-label="Copy viewport" />
                <Sys label="Diff" onClick={() => setIsDiffOpen(true)} className="text-accent-green" />
                <Sys label="⚙️" onClick={() => setIsSettingsOpen(true)} aria-label="Settings" />
              </div>

              <div className="flex items-center gap-1.5">
                <K label="Tab" onClick={() => k('TAB')} wide />
                <K label="Enter" onClick={() => k('ENTER')} wide />
                <div className="flex-1" />
                <K label="↑" onClick={() => k('ARROW_UP')} />
              </div>

              <div className="flex items-center gap-1.5 justify-end">
                <K label="←" onClick={() => k('ARROW_LEFT')} />
                <K label="↓" onClick={() => k('ARROW_DOWN')} />
                <K label="→" onClick={() => k('ARROW_RIGHT')} />
              </div>
            </>
          ) : (
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar mask-gradient-right">
              <Toggle expanded={false} onClick={toggleExpanded} />
              <K label="ESC" onClick={() => k('ESC')} />
              <K label="Tab" onClick={() => k('TAB')} />
              <K label="^C" onClick={() => k('CTRL_C')} className="text-accent-red" />
              <K label="↑" onClick={() => k('ARROW_UP')} />
              <K label="↓" onClick={() => k('ARROW_DOWN')} />
              <K label="←" onClick={() => k('ARROW_LEFT')} />
              <K label="→" onClick={() => k('ARROW_RIGHT')} />
              <Sep />
              <CmdGroup config={config} onCmd={c} />
              <Sys label="⌨️" onClick={() => setIsInputOpen(true)} aria-label="Text input" />
              <Sys label="📷" onClick={() => fileInputRef.current?.click()} aria-label="Upload image" />
              <Sys label="Sel" onClick={() => { hapticTap(); window.dispatchEvent(new Event('terminal-copy-viewport')) }} className="text-accent-purple" aria-label="Copy viewport" />
              <Sys label="Diff" onClick={() => setIsDiffOpen(true)} className="text-accent-green" />
              <Sys label="⚙️" onClick={() => setIsSettingsOpen(true)} aria-label="Settings" />
            </div>
          )}

        </div>
      </div>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onConfigChange={loadConfig}
      />

      <TextInputModal
        isOpen={isInputOpen}
        onClose={() => setIsInputOpen(false)}
        onSend={(text) => sendInput(text)}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleImageUpload(file)
          e.target.value = ''
        }}
      />

      <DiffViewer
        isOpen={isDiffOpen}
        onClose={() => setIsDiffOpen(false)}
      />
    </>
  )
}

const btnBase = 'min-h-[36px] flex items-center justify-center rounded-lg shadow-sm border border-border-subtle text-sm font-mono active:scale-95 active:bg-accent-blue/20 transition-transform duration-100 whitespace-nowrap select-none'

const Toggle: React.FC<{ expanded: boolean; onClick: () => void }> = ({ expanded, onClick }) => (
  <button
    onClick={onClick}
    className={`min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg shadow-sm border text-sm active:scale-95 transition-transform duration-100 shrink-0 select-none ${
      expanded
        ? 'bg-accent-blue/20 border-accent-blue text-accent-blue'
        : 'bg-bg-tertiary/50 border-border-subtle text-text-secondary'
    }`}
    aria-label={expanded ? 'Collapse toolbar' : 'Expand toolbar'}
  >
    {expanded ? '▼' : '▲'}
  </button>
)

const Sep: React.FC = () => <div className="w-px h-5 bg-border-subtle shrink-0" />

const CmdGroup: React.FC<{ config: CommandConfig | null; onCmd: (cmd: string) => void }> = ({ config, onCmd }) => {
  if (!config) return null
  const visible = [
    ...config.defaultCommands.filter(c => c.visible),
    ...config.customCommands,
  ]
  if (visible.length === 0) return null
  return (
    <>
      {visible.map(cmd => (
        <Cmd key={cmd.name} label={cmd.name} onClick={() => onCmd(cmd.cmd)} />
      ))}
      <Sep />
    </>
  )
}

const K: React.FC<{ label: string; onClick: () => void; className?: string; wide?: boolean }> = ({ label, onClick, className = '', wide }) => (
  <button
    onClick={onClick}
    className={`${btnBase} bg-bg-tertiary text-text-primary ${wide ? 'px-4' : 'min-w-[36px] px-2'} ${className}`}
  >
    {label}
  </button>
)

const Cmd: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button
    onClick={onClick}
    className={`${btnBase} bg-bg-tertiary text-accent-blue px-3`}
  >
    {label}
  </button>
)

const Sys: React.FC<{ label: string; onClick: () => void; className?: string; 'aria-label'?: string }> = ({ label, onClick, className = '', ...props }) => (
  <button
    onClick={onClick}
    aria-label={props['aria-label']}
    className={`${btnBase} bg-bg-tertiary/50 text-text-secondary min-w-[36px] px-2 ${className}`}
  >
    {label}
  </button>
)
