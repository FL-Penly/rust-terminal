import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { InputSendResult } from '../contexts/TerminalContext'
import type { UserPreset, UserPresetGroup } from './SettingsModal'
import { copyTextToClipboard, dumpTextToFile } from '../utils/dump-file'

const DRAFT_KEY = 'ttyd_text_input_draft'
const HISTORY_KEY = 'ttyd_input_history'
const HISTORY_MAX = 10
const LINE_HEIGHT = 20
const PADDING_Y = 12
const SINGLE_LINE = LINE_HEIGHT + PADDING_Y
const MAX_HEIGHT_RATIO = 0.4
const VARIABLE_START = '【变量区】'
const VARIABLE_END = '【执行区】'
const VARIABLE_LINE_RE = /^(\s*)([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/
const DERIVED_VARIABLE_KEYS = new Set(['TEST_SCENE_DIR', 'TEST_REPORT_FILE'])
const VARIABLE_EXPRESSION_RE = /\$\{[^}]+}/

const hapticTap = () => { try { navigator.vibrate?.(8) } catch {} }

const loadHistory = (): string[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter(h => typeof h === 'string') : []
  } catch {
    return []
  }
}

interface PromptVariable {
  key: string
  value: string
}

interface GroupVariables {
  editable: PromptVariable[]
  derived: PromptVariable[]
}

interface DumpResult {
  path: string
  copied: boolean
}

const getVariableSection = (text: string): { start: number; end: number } | null => {
  const startMarker = text.indexOf(VARIABLE_START)
  if (startMarker === -1) return null
  const start = startMarker + VARIABLE_START.length
  const endMarker = text.indexOf(VARIABLE_END, start)
  return { start, end: endMarker === -1 ? text.length : endMarker }
}

const extractPromptVariables = (text: string): PromptVariable[] => {
  const section = getVariableSection(text)
  if (!section) return []
  return text
    .slice(section.start, section.end)
    .split(/\r?\n/)
    .map(line => {
      const match = line.match(VARIABLE_LINE_RE)
      return match ? { key: match[2], value: match[3].trim() } : null
    })
    .filter((item): item is PromptVariable => item !== null)
}

const isDerivedVariable = (variable: PromptVariable): boolean => (
  DERIVED_VARIABLE_KEYS.has(variable.key) || VARIABLE_EXPRESSION_RE.test(variable.value)
)

const getEditableVariableValues = (presets: UserPreset[]): Record<string, string> => {
  const variablesByKey = new Map<string, PromptVariable & { derived: boolean }>()
  presets.forEach(preset => {
    extractPromptVariables(preset.text).forEach(variable => {
      const derived = isDerivedVariable(variable)
      const existing = variablesByKey.get(variable.key)
      if (!existing) {
        variablesByKey.set(variable.key, { ...variable, derived })
        return
      }
      if (derived && !existing.derived) {
        variablesByKey.set(variable.key, { ...variable, derived: true })
      }
    })
  })
  const values: Record<string, string> = {}
  variablesByKey.forEach(variable => {
    if (!variable.derived) values[variable.key] = variable.value
  })
  return values
}

const getGroupVariables = (presets: UserPreset[]): GroupVariables => {
  const variablesByKey = new Map<string, PromptVariable & { derived: boolean }>()
  presets.forEach(preset => {
    extractPromptVariables(preset.text).forEach(variable => {
      const derived = isDerivedVariable(variable)
      const existing = variablesByKey.get(variable.key)
      if (!existing) {
        variablesByKey.set(variable.key, { ...variable, derived })
        return
      }
      if (derived && !existing.derived) {
        variablesByKey.set(variable.key, { ...variable, derived: true })
      }
    })
  })
  const variables = Array.from(variablesByKey.values())
  return {
    editable: variables.filter(variable => !variable.derived),
    derived: variables.filter(variable => variable.derived),
  }
}

const sanitizeVariableValue = (value: string): string => value.replace(/\s*\r?\n\s*/g, ' ').trim()

const applyVariablesToPrompt = (text: string, values: Record<string, string>): string => {
  const section = getVariableSection(text)
  if (!section) return text
  const before = text.slice(0, section.start)
  const variableBlock = text.slice(section.start, section.end)
  const after = text.slice(section.end)
  const nextBlock = variableBlock
    .split(/(\r?\n)/)
    .map(part => {
      if (part === '\n' || part === '\r\n') return part
      const match = part.match(VARIABLE_LINE_RE)
      if (!match || !(match[2] in values)) return part
      if (isDerivedVariable({ key: match[2], value: match[3].trim() })) return part
      return `${match[1]}${match[2]} = ${sanitizeVariableValue(values[match[2]])}`
    })
    .join('')
  return before + nextBlock + after
}

interface TextInputBarProps {
  isOpen: boolean
  onClose: () => void
  onSend: (text: string) => InputSendResult | Promise<InputSendResult>
  presetGroups: UserPresetGroup[]
  activePresetGroupId: string
  onActivePresetGroupChange: (groupId: string) => void
  onPresetGroupsChange: (groups: UserPresetGroup[], activeGroupId: string) => void
}

export const TextInputModal: React.FC<TextInputBarProps> = ({
  isOpen,
  onClose,
  onSend,
  presetGroups,
  activePresetGroupId,
  onActivePresetGroupChange,
  onPresetGroupsChange,
}) => {
  const [text, setText] = useState(() => sessionStorage.getItem(DRAFT_KEY) || '')
  const [history, setHistory] = useState<string[]>(loadHistory)
  const [showHistory, setShowHistory] = useState(false)
  const [showGroups, setShowGroups] = useState(false)
  const [managing, setManaging] = useState(false)
  const [showVariables, setShowVariables] = useState(false)
  const [variableValues, setVariableValues] = useState<Record<string, string>>({})
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [formLabel, setFormLabel] = useState('')
  const [formText, setFormText] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [dumpResult, setDumpResult] = useState<DumpResult | null>(null)
  const [dumpError, setDumpError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const activeGroup = presetGroups.find(group => group.id === activePresetGroupId) ?? presetGroups[0]
  const activePresets = activeGroup?.presets ?? []
  const groupVariables = useMemo(() => getGroupVariables(activePresets), [activePresets])
  const editableVariableKeys = useMemo(() => groupVariables.editable.map(variable => variable.key), [groupVariables])
  const hasVariables = groupVariables.editable.length > 0 || groupVariables.derived.length > 0

  const maxHeight = typeof window !== 'undefined'
    ? (window.visualViewport?.height || window.innerHeight) * MAX_HEIGHT_RATIO
    : 200

  const autoResize = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = `${SINGLE_LINE}px`
    const scrollH = ta.scrollHeight
    ta.style.height = `${Math.min(scrollH, maxHeight)}px`
    ta.style.overflowY = scrollH > maxHeight ? 'auto' : 'hidden'
  }, [maxHeight])

  useEffect(() => {
    if (isOpen) {
      const draft = sessionStorage.getItem(DRAFT_KEY)
      if (draft) setText(draft)
      setTimeout(() => {
        textareaRef.current?.focus()
        autoResize()
      }, 50)
    } else {
      setShowHistory(false)
      setShowGroups(false)
      setManaging(false)
      setShowVariables(false)
    }
  }, [isOpen, autoResize])

  useEffect(() => {
    autoResize()
  }, [text, autoResize])

  useEffect(() => {
    setShowVariables(false)
  }, [activeGroup?.id])

  const handleTextChange = useCallback((value: string) => {
    setText(value)
    setSendError(null)
    setDumpResult(null)
    setDumpError(null)
    sessionStorage.setItem(DRAFT_KEY, value)
  }, [])

  const pushHistory = useCallback((entry: string) => {
    setHistory(prev => {
      const next = [entry, ...prev.filter(h => h !== entry)].slice(0, HISTORY_MAX)
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const handleSend = useCallback(async () => {
    if (!text || isSending) return
    setIsSending(true)
    try {
      const result = await onSend(text)
      if (!result.ok) {
        const messages: Record<typeof result.reason, string> = {
          disconnected: '连接已断开，内容已保留，请重连后重试。',
          terminalUnavailable: '终端尚未就绪，内容已保留，请稍后重试。',
          sendFailed: '发送失败，内容已保留，请重试。',
          unsafeMultiline: '当前界面未启用安全多行粘贴，内容已保留，请切换到支持的输入界面后重试。',
        }
        setSendError(result.message ?? messages[result.reason])
        return
      }
      pushHistory(text)
      setSendError(null)
      setText('')
      sessionStorage.removeItem(DRAFT_KEY)
      onClose()
    } catch (error) {
      console.error('[TextInputModal] Failed to send text:', error)
      setSendError('发送失败，内容已保留，请重试。')
    } finally {
      setIsSending(false)
    }
  }, [text, isSending, onSend, onClose, pushHistory])

  const handleDump = useCallback(async () => {
    if (!text) return
    setDumpResult(null)
    setDumpError(null)
    try {
      const path = await dumpTextToFile(text)
      const copied = await copyTextToClipboard(path)
      setDumpResult({ path, copied })
    } catch (error) {
      console.error('[TextInputModal] Failed to dump text:', error)
      setDumpError(error instanceof Error ? error.message : '落盘失败，请重试。')
    }
  }, [text])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  const pickHistory = (entry: string) => {
    hapticTap()
    handleTextChange(entry)
    setShowHistory(false)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  const applyPreset = (preset: UserPreset) => {
    hapticTap()
    const sep = text && !text.endsWith('\n') ? '\n' : ''
    const nextText = text + sep + preset.text
    handleTextChange(nextText)
    setTimeout(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(nextText.length, nextText.length)
    }, 0)
  }

  const toggleHistory = () => {
    setManaging(false)
    setShowGroups(false)
    setShowVariables(false)
    setShowHistory(v => !v)
  }

  const toggleGroups = () => {
    setShowHistory(false)
    setManaging(false)
    setShowVariables(false)
    setShowGroups(v => !v)
  }

  const toggleManage = () => {
    setShowHistory(false)
    setShowGroups(false)
    setShowVariables(false)
    setManaging(v => {
      if (v) resetForm()
      return !v
    })
  }

  const toggleVariables = () => {
    setShowHistory(false)
    setShowGroups(false)
    setManaging(false)
    setShowVariables(v => {
      if (!v) setVariableValues(getEditableVariableValues(activePresets))
      return !v
    })
  }

  const resetForm = () => {
    setEditingIdx(null)
    setFormLabel('')
    setFormText('')
  }

  const startEdit = (idx: number) => {
    setEditingIdx(idx)
    setFormLabel(activePresets[idx].label)
    setFormText(activePresets[idx].text)
  }

  const selectGroup = (groupId: string) => {
    hapticTap()
    onActivePresetGroupChange(groupId)
    setShowGroups(false)
    setManaging(false)
    resetForm()
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  const updateActivePresets = (nextPresets: UserPreset[]) => {
    if (!activeGroup) return
    const nextGroups = presetGroups.length > 0
      ? presetGroups.map(group => group.id === activeGroup.id ? { ...group, presets: nextPresets } : group)
      : [{ ...activeGroup, presets: nextPresets }]
    onPresetGroupsChange(nextGroups, activeGroup.id)
  }

  const applyGroupVariables = () => {
    if (!activeGroup || editableVariableKeys.length === 0) return
    const editableValues = editableVariableKeys.reduce<Record<string, string>>((next, key) => {
      next[key] = variableValues[key] ?? ''
      return next
    }, {})
    const nextPresets = activePresets.map(preset => ({
      ...preset,
      text: applyVariablesToPrompt(preset.text, editableValues),
    }))
    hapticTap()
    updateActivePresets(nextPresets)
    setShowVariables(false)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  const savePreset = () => {
    const label = formLabel.trim()
    const value = formText
    if (!label || !value.trim()) return
    const entry: UserPreset = { label, text: value }
    const next = [...activePresets]
    if (editingIdx !== null) next[editingIdx] = entry
    else next.push(entry)
    updateActivePresets(next)
    resetForm()
  }

  const deletePreset = (idx: number) => {
    updateActivePresets(activePresets.filter((_, i) => i !== idx))
    if (editingIdx === idx) resetForm()
  }

  if (!isOpen) return null

  return (
    <div className="shrink-0 flex flex-col bg-bg-secondary border-t border-border-subtle">
      {showHistory && (
        <div className="max-h-[40vh] overflow-y-auto border-b border-border-subtle">
          {history.length === 0 ? (
            <div className="px-3 py-4 text-center text-text-muted text-xs">No history yet</div>
          ) : (
            history.map((entry, i) => (
              <button
                key={i}
                onClick={() => pickHistory(entry)}
                className="w-full text-left px-3 py-2 font-mono text-sm text-text-primary truncate hover:bg-bg-tertiary active:bg-accent-blue/10 transition-colors border-b border-border-subtle/50 last:border-b-0"
              >
                {entry.replace(/\s+/g, ' ').trim()}
              </button>
            ))
          )}
        </div>
      )}

      {showGroups && (
        <div className="max-h-[40vh] overflow-y-auto border-b border-border-subtle p-1.5">
          {presetGroups.map(group => (
            <button
              key={group.id}
              onClick={() => selectGroup(group.id)}
              className={`w-full h-[34px] px-3 flex items-center gap-2 rounded-lg text-sm transition-colors ${
                group.id === activeGroup?.id
                  ? 'bg-accent-blue/20 text-accent-blue border border-accent-blue/40'
                  : 'text-text-primary hover:bg-bg-tertiary border border-transparent'
              }`}
            >
              <span className="font-medium truncate">{group.label}</span>
              <span className="ml-auto text-xs text-text-muted">{group.presets.length}</span>
            </button>
          ))}
          {presetGroups.length === 0 && (
            <div className="px-3 py-4 text-center text-text-muted text-xs">No groups yet</div>
          )}
        </div>
      )}

      {managing && (
        <div className="max-h-[50vh] overflow-y-auto border-b border-border-subtle p-2 flex flex-col gap-2">
          <input
            type="text"
            value={formLabel}
            onChange={e => setFormLabel(e.target.value)}
            placeholder={`${activeGroup?.label ?? 'Preset'} label`}
            className="h-[32px] bg-bg-primary border border-border-subtle rounded-lg px-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue/60"
          />
          <textarea
            value={formText}
            onChange={e => setFormText(e.target.value)}
            placeholder="Preset content (multi-line context)…"
            rows={3}
            className="bg-bg-primary border border-border-subtle rounded-lg px-3 py-1.5 font-mono text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue/60 resize-none"
          />
          <div className="flex items-center justify-end gap-2">
            {editingIdx !== null && (
              <button
                onClick={resetForm}
                className="px-3 h-[32px] rounded-lg text-xs text-text-secondary hover:bg-bg-tertiary transition-colors"
              >
                Cancel
              </button>
            )}
            <button
              onClick={savePreset}
              disabled={!formLabel.trim() || !formText.trim()}
              className="px-3 h-[32px] rounded-lg text-xs font-medium bg-accent-blue/10 text-accent-blue border border-accent-blue/30 disabled:opacity-30 transition-colors"
            >
              {editingIdx !== null ? 'Save' : 'Add'}
            </button>
          </div>

          {activePresets.length > 0 && (
            <div className="flex flex-col gap-1 pt-1 border-t border-border-subtle/50">
              {activePresets.map((p, idx) => (
                <div key={idx} className="flex items-center gap-2 px-1 py-1 rounded-lg">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-accent-blue truncate">{p.label}</div>
                    <div className="text-xs text-text-muted font-mono truncate">{p.text.replace(/\s+/g, ' ').trim()}</div>
                  </div>
                  <button
                    onClick={() => startEdit(idx)}
                    className="shrink-0 px-2 h-[28px] rounded-md text-xs text-text-secondary hover:bg-bg-tertiary transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => setDeleteConfirm(idx)}
                    className="shrink-0 px-2 h-[28px] rounded-md text-xs text-accent-red hover:bg-accent-red/10 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showVariables && (
        <div className="max-h-[50vh] overflow-y-auto border-b border-border-subtle p-2 flex flex-col gap-2">
          {!hasVariables ? (
            <div className="px-3 py-4 text-center text-text-muted text-xs">当前分组没有变量区</div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 px-1">
                <div className="text-xs font-semibold text-text-secondary truncate">需要填写</div>
                <button
                  onClick={applyGroupVariables}
                  disabled={editableVariableKeys.length === 0}
                  className="shrink-0 px-3 h-[30px] rounded-lg text-xs font-medium bg-accent-blue/10 text-accent-blue border border-accent-blue/30 disabled:opacity-30 transition-colors"
                >
                  应用
                </button>
              </div>
              {editableVariableKeys.length === 0 ? (
                <div className="px-3 py-4 text-center text-text-muted text-xs">当前分组只有自动生成变量</div>
              ) : (
                <div className="grid grid-cols-1 gap-2">
                  {editableVariableKeys.map(key => (
                    <label key={key} className="flex flex-col gap-1">
                      <span className="text-[11px] font-mono text-text-muted">{key}</span>
                      <textarea
                        value={variableValues[key] ?? ''}
                        rows={2}
                        onChange={e => setVariableValues(prev => ({ ...prev, [key]: e.target.value }))}
                        className="min-h-[40px] bg-bg-primary border border-border-subtle rounded-lg px-2 py-1.5 font-mono text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue/60 resize-none"
                      />
                    </label>
                  ))}
                </div>
              )}
              {groupVariables.derived.length > 0 && (
                <details className="px-1 pt-1">
                  <summary className="cursor-pointer text-[11px] text-text-muted">
                    自动生成变量 {groupVariables.derived.length}
                  </summary>
                  <div className="mt-1 flex flex-col gap-1">
                    {groupVariables.derived.map(variable => (
                      <div key={variable.key} className="font-mono text-[11px] text-text-muted break-all">
                        {variable.key} = {variable.value}
                      </div>
                    ))}
                  </div>
                </details>
              )}
              <div className="px-1 text-[11px] text-text-muted">只替换“需要填写”的变量；自动生成变量保持表达式不变。</div>
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 px-2 pt-1.5">
        <button
          onClick={toggleHistory}
          aria-label="History"
          className={`shrink-0 min-w-[36px] h-[32px] flex items-center justify-center rounded-lg border text-sm transition-colors ${
            showHistory ? 'bg-accent-blue/20 border-accent-blue text-accent-blue' : 'bg-bg-tertiary/50 border-border-subtle text-text-secondary'
          }`}
        >
          🕘
        </button>
        <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto no-scrollbar">
          <button
            onClick={toggleGroups}
            className={`shrink-0 h-[32px] max-w-[36vw] px-3 flex items-center gap-1.5 rounded-lg border text-sm font-semibold truncate transition-colors ${
              showGroups ? 'bg-accent-blue/20 border-accent-blue text-accent-blue' : 'bg-bg-tertiary border-accent-blue/50 text-text-primary'
            }`}
          >
            <span className="truncate">{activeGroup?.label ?? '默认'}</span>
            <span className="text-text-muted">⌄</span>
          </button>
          <button
            onClick={toggleVariables}
            disabled={!hasVariables}
            className={`shrink-0 h-[32px] px-3 flex items-center rounded-lg border text-sm font-semibold transition-colors disabled:opacity-30 ${
              showVariables ? 'bg-accent-blue/20 border-accent-blue text-accent-blue' : 'bg-bg-tertiary/50 border-border-subtle text-text-secondary'
            }`}
          >
            变量
          </button>
          {activePresets.map((p, idx) => (
            <button
              key={idx}
              onClick={() => applyPreset(p)}
              title={p.text}
              className="shrink-0 h-[32px] max-w-[40vw] px-3 flex items-center rounded-lg border border-border-subtle bg-bg-tertiary text-text-primary text-sm font-medium truncate active:scale-95 active:bg-accent-blue/20 transition-transform duration-100 select-none"
            >
              {p.label}
            </button>
          ))}
        </div>
        <button
          onClick={toggleManage}
          aria-label="Manage presets"
          className={`shrink-0 min-w-[36px] h-[32px] flex items-center justify-center rounded-lg border text-sm transition-colors ${
            managing ? 'bg-accent-orange/20 border-accent-orange text-accent-orange' : 'bg-bg-tertiary/50 border-border-subtle text-text-secondary'
          }`}
        >
          ＋
        </button>
      </div>

      <div className="flex items-end gap-1.5 px-2 py-1.5">
        <button
          onClick={onClose}
          className="shrink-0 w-8 h-8 flex items-center justify-center text-text-secondary active:bg-bg-tertiary rounded-lg text-sm mb-[1px]"
        >
          ✕
        </button>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => handleTextChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type or paste text..."
          rows={1}
          className="flex-1 bg-bg-primary border border-border-subtle rounded-lg px-3 py-1.5 font-mono text-sm text-text-primary leading-5 focus:outline-none focus:border-accent-blue resize-none min-w-0"
          style={{ height: `${SINGLE_LINE}px`, overflowY: 'hidden' }}
        />
        <button
          onClick={() => { void handleDump() }}
          disabled={!text}
          aria-label="落盘并复制路径"
          title="落盘并复制路径"
          className="shrink-0 px-2 h-8 bg-bg-tertiary text-text-primary border border-border-subtle text-xs rounded-lg font-medium active:opacity-80 disabled:opacity-40 mb-[1px]"
        >
          落盘
        </button>
        <button
          onClick={() => { void handleSend() }}
          disabled={!text || isSending}
          className="shrink-0 px-3 h-8 bg-accent-blue text-white text-sm rounded-lg font-medium active:opacity-80 disabled:opacity-40 mb-[1px]"
        >
          {isSending ? '发送中…' : 'Send'}
        </button>
      </div>

      {sendError && (
        <div role="alert" className="px-3 pb-1.5 text-xs text-accent-red">
          {sendError}
        </div>
      )}

      {dumpError && (
        <div role="alert" className="px-3 pb-1.5 text-xs text-accent-red break-words">
          {dumpError}
        </div>
      )}

      {dumpResult && (
        <div role="status" className={`px-3 pb-1.5 text-xs break-words ${dumpResult.copied ? 'text-accent-green' : 'text-accent-orange'}`}>
          <span>{dumpResult.copied ? '已落盘：' : '已落盘，但自动复制失败：'}</span>
          <span className="font-mono select-text break-all">{dumpResult.path}</span>
        </div>
      )}

      {deleteConfirm !== null && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center px-4" onClick={() => setDeleteConfirm(null)}>
          <div className="bg-bg-secondary border border-border-subtle rounded-xl shadow-2xl max-w-sm w-full p-4" onClick={e => e.stopPropagation()}>
            <p className="text-[13px] text-text-primary">Delete preset <span className="font-semibold text-accent-blue">{activePresets[deleteConfirm]?.label}</span>?</p>
            <div className="flex items-center justify-end gap-2 mt-4">
              <button onClick={() => setDeleteConfirm(null)} className="px-3 py-1.5 text-[12px] rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors">
                Cancel
              </button>
              <button
                onClick={() => { deletePreset(deleteConfirm); setDeleteConfirm(null) }}
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
