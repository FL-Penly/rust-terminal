import React, { useState, useEffect, useRef } from 'react'
import { useTerminal } from '../contexts/TerminalContext'
import { SettingsModal, UserConfig, UserCommand, DEFAULT_CONFIG, loadUserConfig, saveUserConfig } from './SettingsModal'

import { TextInputModal } from './TextInputModal'
import { GitPanel } from './GitPanel'

const hapticTap = () => { try { navigator.vibrate?.(8) } catch {} }

export const Toolbar: React.FC = () => {
  const { sendKey, sendInput, submitText } = useTerminal()
  const [config, setConfig] = useState<UserConfig>(DEFAULT_CONFIG)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isInputOpen, setIsInputOpen] = useState(false)
  const [isGitOpen, setIsGitOpen] = useState(false)
  const [isPickerOpen, setIsPickerOpen] = useState(false)
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

  useEffect(() => {
    loadUserConfig().then(setConfig)
  }, [])

  const exec = (cmd: UserCommand) => {
    hapticTap()
    sendInput(cmd.cmd + (cmd.autoEnter ? '\r' : ''))
  }

  const k = (key: Parameters<typeof sendKey>[0]) => {
    hapticTap()
    sendKey(key)
  }

  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileUpload = async (file: File) => {
    try {
      const response = await fetch(`/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name),
        },
        body: file,
        signal: AbortSignal.timeout(30000),
      })
      if (!response.ok) throw new Error(`Upload failed: ${response.status}`)
      const { path } = await response.json()
      sendInput(path)
    } catch (err) {
      console.error('[Toolbar] File upload failed:', err)
    }
  }

  const addCmd = (cmd: UserCommand) => {
    const updated = { ...config, commands: [...config.commands, cmd] }
    setConfig(updated)
    saveUserConfig(updated)
  }

  const persistConfig = (updated: UserConfig) => {
    setConfig(updated)
    saveUserConfig(updated)
  }

  const setActivePresetGroup = (groupId: string) => {
    const activeGroup = config.presetGroups.find(group => group.id === groupId) ?? config.presetGroups[0]
    persistConfig({
      ...config,
      activePresetGroupId: activeGroup?.id ?? groupId,
      presets: activeGroup?.presets ?? [],
    })
  }

  const updatePresetGroups = (presetGroups: UserConfig['presetGroups'], activePresetGroupId: string) => {
    const activeGroup = presetGroups.find(group => group.id === activePresetGroupId) ?? presetGroups[0]
    persistConfig({
      ...config,
      presetGroups,
      activePresetGroupId: activeGroup?.id ?? activePresetGroupId,
      presets: activeGroup?.presets ?? [],
    })
  }

  return (
    <>
      <div className="shrink-0 flex flex-col">
        <TextInputModal
          isOpen={isInputOpen}
          onClose={() => setIsInputOpen(false)}
          onSend={submitText}
          presetGroups={config.presetGroups}
          activePresetGroupId={config.activePresetGroupId}
          onActivePresetGroupChange={setActivePresetGroup}
          onPresetGroupsChange={updatePresetGroups}
        />

        {isPickerOpen && (
          <CommandPicker
            commands={config.commands}
            onExecute={(cmd) => { exec(cmd); setIsPickerOpen(false) }}
            onClose={() => setIsPickerOpen(false)}
            onAdd={addCmd}
            onDelete={(idx) => {
              const updated = { ...config, commands: config.commands.filter((_, i) => i !== idx) }
              setConfig(updated)
              saveUserConfig(updated)
            }}
            onReorder={(cmds) => {
              const updated = { ...config, commands: cmds }
              setConfig(updated)
              saveUserConfig(updated)
            }}
          />
        )}

        <div className="bg-bg-secondary border-t border-border-subtle pb-[env(safe-area-inset-bottom)]">
          <div className="flex flex-col gap-1.5 px-2 py-1.5">

            {isExpanded ? (
              <>
                <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                  <Toggle expanded onClick={toggleExpanded} />
                  <K label="ESC" onClick={() => k('ESC')} />
                  <K label="^C" onClick={() => k('CTRL_C')} className="text-accent-red" />
                  <K label="^L" onClick={() => k('CTRL_L')} />
                  <Sep />
                  <Sys label="💬" onClick={() => setIsPickerOpen(!isPickerOpen)} className="text-accent-orange" aria-label="Commands" />
                  <Sys label="⌨️" onClick={() => setIsInputOpen(true)} aria-label="Text input" />
                  <Sys label="📎" onClick={() => fileInputRef.current?.click()} aria-label="Upload file" />
                  <Sys label="Sel" onClick={() => { hapticTap(); window.dispatchEvent(new Event('terminal-copy-viewport')) }} className="text-accent-purple" aria-label="Copy viewport" />
                  <Sys label="Git" onClick={() => setIsGitOpen(true)} className="text-accent-purple" />
                  <Sys label="⚙️" onClick={() => setIsSettingsOpen(true)} aria-label="Settings" />
                </div>

                <div className="flex items-center gap-1.5">
                  <K label="Tab" onClick={() => k('TAB')} wide />
                  <K label="⇧Tab" onClick={() => k('SHIFT_TAB')} wide />
                  <K label="Enter" onClick={() => k('ENTER')} wide />
                  <K label="⇧Enter" onClick={() => k('SHIFT_ENTER')} wide />
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
                <K label="⇧Tab" onClick={() => k('SHIFT_TAB')} />
                <K label="⇧Enter" onClick={() => k('SHIFT_ENTER')} />
                <K label="^C" onClick={() => k('CTRL_C')} className="text-accent-red" />
                <K label="↑" onClick={() => k('ARROW_UP')} />
                <K label="↓" onClick={() => k('ARROW_DOWN')} />
                <K label="←" onClick={() => k('ARROW_LEFT')} />
                <K label="→" onClick={() => k('ARROW_RIGHT')} />
                <Sep />
                <Sys label="💬" onClick={() => setIsPickerOpen(!isPickerOpen)} className="text-accent-orange" aria-label="Commands" />
                <Sys label="⌨️" onClick={() => setIsInputOpen(true)} aria-label="Text input" />
                <Sys label="📎" onClick={() => fileInputRef.current?.click()} aria-label="Upload file" />
                <Sys label="Sel" onClick={() => { hapticTap(); window.dispatchEvent(new Event('terminal-copy-viewport')) }} className="text-accent-purple" aria-label="Copy viewport" />
                <Sys label="Git" onClick={() => setIsGitOpen(true)} className="text-accent-purple" />
                <Sys label="⚙️" onClick={() => setIsSettingsOpen(true)} aria-label="Settings" />
              </div>
            )}

          </div>
        </div>
      </div>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleFileUpload(file)
          e.target.value = ''
        }}
      />

      <GitPanel
        isOpen={isGitOpen}
        onClose={() => setIsGitOpen(false)}
      />
    </>
  )
}

const btnBase = 'min-h-[36px] flex items-center justify-center rounded-lg shadow-sm border border-border-subtle text-sm font-mono active:scale-95 active:bg-accent-blue/20 transition-transform duration-100 whitespace-nowrap select-none'

const Toggle: React.FC<{ expanded: boolean; onClick: () => void }> = ({ expanded, onClick }) => (
  <button
    onClick={onClick}
    onMouseDown={e => e.preventDefault()}
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

const K: React.FC<{ label: string; onClick: () => void; className?: string; wide?: boolean }> = ({ label, onClick, className = '', wide }) => (
  <button
    onClick={onClick}
    onMouseDown={e => e.preventDefault()}
    className={`${btnBase} bg-bg-tertiary text-text-primary ${wide ? 'px-4' : 'min-w-[36px] px-2'} ${className}`}
  >
    {label}
  </button>
)

const Sys: React.FC<{ label: string; onClick: () => void; className?: string; 'aria-label'?: string }> = ({ label, onClick, className = '', ...props }) => (
  <button
    onClick={onClick}
    onMouseDown={e => e.preventDefault()}
    aria-label={props['aria-label']}
    className={`${btnBase} bg-bg-tertiary/50 text-text-secondary min-w-[36px] px-2 ${className}`}
  >
    {label}
  </button>
)

const CommandPicker: React.FC<{
  commands: UserCommand[]
  onExecute: (cmd: UserCommand) => void
  onClose: () => void
  onAdd: (cmd: UserCommand) => void
  onDelete: (idx: number) => void
  onReorder: (commands: UserCommand[]) => void
}> = ({ commands, onExecute, onClose, onAdd, onDelete, onReorder }) => {
  const [search, setSearch] = useState('')
  const [addMode, setAddMode] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newCmd, setNewCmd] = useState('')
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const longPressTimer = useRef<number | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current)
    }
  }, [])

  useEffect(() => {
    const handleClick = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('touchstart', handleClick, { passive: true })
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('touchstart', handleClick)
    }
  }, [onClose])

  const isSearching = search.length > 0
  const query = search.toLowerCase()
  const filtered = commands.filter(c =>
    c.label.toLowerCase().includes(query) || c.cmd.toLowerCase().includes(query)
  )

  const handleAdd = () => {
    if (!newLabel.trim()) return
    onAdd({ label: newLabel.trim(), cmd: newCmd.trim() || newLabel.trim(), autoEnter: true })
    setNewLabel('')
    setNewCmd('')
    setAddMode(false)
  }

  const finishDrag = (toIdx: number) => {
    if (dragIdx === null || dragIdx === toIdx) return
    const updated = [...commands]
    const [moved] = updated.splice(dragIdx, 1)
    updated.splice(toIdx, 0, moved)
    onReorder(updated)
    setDragIdx(null)
    setDragOverIdx(null)
  }

  return (
    <div ref={ref} className="bg-bg-secondary border-t border-border-subtle max-h-[50vh] flex flex-col">
      <div className="px-2 pt-2 pb-1 flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search commands..."
          className="flex-1 h-[36px] bg-bg-primary border border-border-subtle rounded-lg px-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-orange/60"
        />
        <button
          onClick={() => setAddMode(!addMode)}
          className={`h-[36px] w-[36px] rounded-lg border text-sm font-medium transition-colors ${
            addMode ? 'bg-accent-orange/20 border-accent-orange text-accent-orange' : 'bg-bg-tertiary border-border-subtle text-text-secondary'
          }`}
        >
          +
        </button>
      </div>

      {addMode && (
        <div className="px-2 pb-1 flex items-center gap-2">
          <input
            type="text"
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
            placeholder="Label"
            autoFocus
            className="flex-1 h-[32px] bg-bg-primary border border-border-subtle rounded-lg px-3 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue/60"
          />
          <input
            type="text"
            value={newCmd}
            onChange={e => setNewCmd(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
            placeholder="Command (optional)"
            className="flex-1 h-[32px] bg-bg-primary border border-border-subtle rounded-lg px-3 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue/60"
          />
          <button
            onClick={handleAdd}
            disabled={!newLabel.trim()}
            className="h-[32px] px-3 rounded-lg text-xs font-medium bg-accent-blue/10 text-accent-blue border border-accent-blue/30 disabled:opacity-30 transition-colors"
          >
            Add
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-1 pb-1">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-text-muted text-xs">
            {search ? 'No matching commands' : 'No commands — tap + to add'}
          </div>
        ) : (
          filtered.map((cmd) => {
            const realIdx = commands.indexOf(cmd)
            const isDragging = dragIdx === realIdx
            const isDragOver = dragOverIdx === realIdx
            const startLongPress = () => {
              longPressTimer.current = window.setTimeout(() => {
                setDeleteConfirm(realIdx)
              }, 800)
            }
            const cancelLongPress = () => {
              if (longPressTimer.current) {
                clearTimeout(longPressTimer.current)
                longPressTimer.current = null
              }
            }
            return (
              <div
                key={`${cmd.label}-${realIdx}`}
                draggable={!isSearching}
                onDragStart={() => setDragIdx(realIdx)}
                onDragOver={(e) => { e.preventDefault(); setDragOverIdx(realIdx) }}
                onDrop={() => finishDrag(realIdx)}
                onDragEnd={() => { setDragIdx(null); setDragOverIdx(null) }}
                className={`flex items-center gap-1 rounded-lg transition-colors ${
                  isDragging ? 'opacity-30' : isDragOver ? 'bg-accent-blue/10' : ''
                }`}
              >
                {!isSearching && (
                  <span className="text-[10px] text-text-muted cursor-grab active:cursor-grabbing px-1 select-none">⠿</span>
                )}
                <button
                  onClick={() => { if (!longPressTimer.current) onExecute(cmd) }}
                  onTouchStart={startLongPress}
                  onTouchEnd={cancelLongPress}
                  onTouchMove={cancelLongPress}
                  onMouseDown={startLongPress}
                  onMouseUp={cancelLongPress}
                  onMouseLeave={cancelLongPress}
                  className="flex-1 flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-bg-tertiary active:bg-accent-blue/10 transition-colors min-w-0"
                >
                  <span className="text-sm font-medium text-accent-blue shrink-0">{cmd.label}</span>
                  {cmd.label !== cmd.cmd && (
                    <span className="text-xs text-text-muted truncate">{cmd.cmd}</span>
                  )}
                  <div className="flex-1" />
                  {cmd.autoEnter && <span className="text-[10px] text-text-muted">⏎</span>}
                </button>
              </div>
            )
          })
        )}
      </div>

      {deleteConfirm !== null && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center px-4" onClick={() => setDeleteConfirm(null)}>
          <div className="bg-bg-secondary border border-border-subtle rounded-xl shadow-2xl max-w-sm w-full p-4" onClick={e => e.stopPropagation()}>
            <p className="text-[13px] text-text-primary">Delete <span className="font-semibold text-accent-blue">{commands[deleteConfirm]?.label}</span>?</p>
            <p className="text-[12px] text-text-muted mt-1 font-mono truncate">{commands[deleteConfirm]?.cmd}</p>
            <div className="flex items-center justify-end gap-2 mt-4">
              <button onClick={() => setDeleteConfirm(null)} className="px-3 py-1.5 text-[12px] rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors">
                Cancel
              </button>
              <button
                onClick={() => { onDelete(deleteConfirm); setDeleteConfirm(null) }}
                className="px-3 py-1.5 text-[12px] rounded-md bg-accent-red text-white hover:bg-accent-red/80 font-medium transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
