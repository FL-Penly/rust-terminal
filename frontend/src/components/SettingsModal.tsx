import React, { useState, useEffect } from 'react'

export interface CommandConfig {
  defaultCommands: {
    name: string
    cmd: string
    visible: boolean
  }[]
  customCommands: {
    name: string
    cmd: string
  }[]
}

const DEFAULT_CONFIG: CommandConfig = {
  defaultCommands: [
    { name: 'claude', cmd: 'claude --dangerously-skip-permissions', visible: true },
    { name: 'opencode', cmd: 'opencode', visible: true }
  ],
  customCommands: []
}

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  onConfigChange: () => void
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, onConfigChange }) => {
  const [config, setConfig] = useState<CommandConfig>(DEFAULT_CONFIG)
  const [newCmdName, setNewCmdName] = useState('')
  const [newCmdContent, setNewCmdContent] = useState('')
  const [predictiveEcho, setPredictiveEcho] = useState(() => localStorage.getItem('terminal_predictive_echo') === 'on')

  useEffect(() => {
    if (isOpen) {
      const saved = localStorage.getItem('ttyd_commands')
      if (saved) {
        try {
          setConfig(JSON.parse(saved))
        } catch (e) {
          console.error('Failed to parse ttyd_commands', e)
        }
      } else {
        setConfig(DEFAULT_CONFIG)
      }
    }
  }, [isOpen])

  const saveConfig = (newConfig: CommandConfig) => {
    setConfig(newConfig)
    localStorage.setItem('ttyd_commands', JSON.stringify(newConfig))
    onConfigChange()
  }

  const toggleDefault = (index: number) => {
    const newDefaults = [...config.defaultCommands]
    newDefaults[index].visible = !newDefaults[index].visible
    saveConfig({ ...config, defaultCommands: newDefaults })
  }

  const deleteCustom = (index: number) => {
    const newCustoms = config.customCommands.filter((_, i) => i !== index)
    saveConfig({ ...config, customCommands: newCustoms })
  }

  const addCustom = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newCmdName.trim() || !newCmdContent.trim()) return

    const newCustoms = [
      ...config.customCommands,
      { name: newCmdName.trim(), cmd: newCmdContent.trim() }
    ]
    saveConfig({ ...config, customCommands: newCustoms })
    setNewCmdName('')
    setNewCmdContent('')
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
      <div 
        className="bg-bg-secondary w-full max-w-sm mx-4 rounded-xl shadow-2xl border border-border-subtle flex flex-col max-h-[80vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border-subtle">
          <h2 className="text-lg font-semibold text-text-primary">Command Settings</h2>
          <button 
            onClick={onClose}
            className="p-2 text-text-secondary hover:text-text-primary transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-6">
          {/* Default Commands Section */}
          <section>
            <h3 className="text-sm font-medium text-text-muted uppercase tracking-wider mb-3">Built-in Commands</h3>
            <div className="space-y-2">
              {config.defaultCommands.map((cmd, idx) => (
                <div key={cmd.name} className="flex items-center justify-between bg-bg-tertiary p-3 rounded-lg">
                  <span className="font-mono text-sm text-text-primary">{cmd.name}</span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input 
                      type="checkbox" 
                      className="sr-only peer"
                      checked={cmd.visible}
                      onChange={() => toggleDefault(idx)}
                    />
                    <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent-green"></div>
                  </label>
                </div>
              ))}
            </div>
          </section>

          {/* Custom Commands Section */}
          <section>
            <h3 className="text-sm font-medium text-text-muted uppercase tracking-wider mb-3">Custom Commands</h3>
            {config.customCommands.length === 0 ? (
              <p className="text-sm text-text-muted italic">No custom commands added</p>
            ) : (
              <div className="space-y-2">
                {config.customCommands.map((cmd, idx) => (
                  <div key={idx} className="flex items-center justify-between bg-bg-tertiary p-3 rounded-lg">
                    <div className="flex flex-col min-w-0 mr-2">
                      <span className="font-mono text-sm text-text-primary truncate">{cmd.name}</span>
                      <span className="font-mono text-xs text-text-muted truncate">{cmd.cmd}</span>
                    </div>
                    <button 
                      onClick={() => deleteCustom(idx)}
                      className="p-2 text-text-secondary hover:text-accent-red transition-colors"
                    >
                      🗑️
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <h3 className="text-sm font-medium text-text-muted uppercase tracking-wider mb-3">Performance</h3>
            <div className="flex items-center justify-between bg-bg-tertiary p-3 rounded-lg">
              <div className="flex flex-col">
                <span className="text-sm text-text-primary">Predictive Echo</span>
                <span className="text-xs text-text-muted">Show keystrokes before server confirms</span>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={predictiveEcho}
                  onChange={() => {
                    const next = !predictiveEcho
                    setPredictiveEcho(next)
                    localStorage.setItem('terminal_predictive_echo', next ? 'on' : 'off')
                    window.dispatchEvent(new CustomEvent('predictive-echo-changed', { detail: next }))
                  }}
                />
                <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent-green"></div>
              </label>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-medium text-text-muted uppercase tracking-wider mb-3">Add New Command</h3>
            <form onSubmit={addCustom} className="space-y-3">
              <div>
                <input
                  type="text"
                  placeholder="Button Name (e.g. ls -la)"
                  value={newCmdName}
                  onChange={e => setNewCmdName(e.target.value)}
                  className="w-full bg-bg-primary border border-border-subtle rounded px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent-blue"
                />
              </div>
              <div>
                <input
                  type="text"
                  placeholder="Command (e.g. ls -la\r)"
                  value={newCmdContent}
                  onChange={e => setNewCmdContent(e.target.value)}
                  className="w-full bg-bg-primary border border-border-subtle rounded px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent-blue"
                />
              </div>
              <button 
                type="submit"
                disabled={!newCmdName.trim() || !newCmdContent.trim()}
                className="w-full py-2 bg-accent-blue/10 text-accent-blue border border-accent-blue/30 rounded font-medium hover:bg-accent-blue/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Add Command
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  )
}
