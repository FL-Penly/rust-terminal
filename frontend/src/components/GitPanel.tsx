import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useTerminal } from '../contexts/TerminalContext'
import { withTerminalTarget } from '../utils/terminal-api'

interface StatusFile {
  file: string
  status: string
}

interface GitStatus {
  staged: StatusFile[]
  unstaged: StatusFile[]
  branch: string
}

interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  old_num?: number
  new_num?: number
  content: string
}

interface DiffHunk {
  header: string
  lines: DiffLine[]
}

interface FileDiff {
  filename: string
  status: string
  additions: number
  deletions: number
  binary?: boolean
  hunks: DiffHunk[]
}

interface DiffResult {
  files: FileDiff[]
  summary: {
    totalFiles: number
    totalAdditions: number
    totalDeletions: number
  }
}

interface GitLogEntry {
  hash: string
  message: string
  author: string
  date: string
  context: string
}

interface GitPanelProps {
  isOpen: boolean
  onClose: () => void
}

const STATUS_BADGE: Record<string, { bg: string; text: string }> = {
  M: { bg: 'bg-[#e3b341]', text: 'text-[#e3b341]' },
  A: { bg: 'bg-accent-green', text: 'text-accent-green' },
  D: { bg: 'bg-accent-red', text: 'text-accent-red' },
  R: { bg: 'bg-[#58a6ff]', text: 'text-[#58a6ff]' },
  C: { bg: 'bg-[#58a6ff]', text: 'text-[#58a6ff]' },
  U: { bg: 'bg-accent-green', text: 'text-accent-green' },
}

const LINE_BG: Record<string, string> = {
  add: 'bg-[rgba(63,185,80,0.12)]',
  del: 'bg-[rgba(248,81,73,0.12)]',
  ctx: '',
}

const LINE_GUTTER: Record<string, string> = {
  add: 'text-accent-green',
  del: 'text-accent-red',
  ctx: 'text-[#484f58]',
}

const LINE_PREFIX: Record<string, string> = {
  add: '+',
  del: '-',
  ctx: ' ',
}

async function gitFetch<T>(url: string, options?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), ...options })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function gitPost(url: string, body: object): Promise<{ success?: boolean } | null> {
  return gitFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function buildHunkPatch(filename: string, hunk: DiffHunk, status?: string): string {
  const oldHeader = status === 'A' ? '--- /dev/null' : `--- a/${filename}`
  const newHeader = status === 'D' ? '+++ /dev/null' : `+++ b/${filename}`
  const lines = [
    oldHeader,
    newHeader,
    hunk.header,
    ...hunk.lines.map(line => {
      const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
      return prefix + line.content
    }),
  ]
  return lines.join('\n') + '\n'
}

export const GitPanel: React.FC<GitPanelProps> = ({ isOpen, onClose }) => {
  const { mux, paneId, clientTty } = useTerminal()
  const gitUrl = useCallback(
    (url: string) => withTerminalTarget(url, mux, paneId, clientTty),
    [clientTty, mux, paneId],
  )
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitLogEntry[]>([])
  const [commitMsg, setCommitMsg] = useState('')
  const [actionInProgress, setActionInProgress] = useState(false)
  const [expandedFile, setExpandedFile] = useState<string | null>(null)
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [stagedCollapsed, setStagedCollapsed] = useState(false)
  const [changesCollapsed, setChangesCollapsed] = useState(false)
  const [commitsCollapsed, setCommitsCollapsed] = useState(true)
  const [discardConfirm, setDiscardConfirm] = useState<StatusFile | null>(null)
  const [reviewMode, setReviewMode] = useState(false)
  const [reviewDiffs, setReviewDiffs] = useState<Map<string, FileDiff>>(new Map())
  const [reviewLoading, setReviewLoading] = useState(false)
  const [collapsedReviewFiles, setCollapsedReviewFiles] = useState<Set<string>>(new Set())
  const [selectedCommit, setSelectedCommit] = useState<GitLogEntry | null>(null)
  const [commitDiff, setCommitDiff] = useState<DiffResult | null>(null)
  const [commitDiffError, setCommitDiffError] = useState(false)
  const [hunkDiscardConfirm, setHunkDiscardConfirm] = useState<{ filename: string; hunk: DiffHunk } | null>(null)

  const fetchStatus = useCallback(async () => {
    const data = await gitFetch<GitStatus>(gitUrl('/api/git/status'))
    if (data) setStatus(data)
  }, [gitUrl])

  const fetchLog = useCallback(async () => {
    const data = await gitFetch<GitLogEntry[]>(gitUrl('/api/git/log?count=30'))
    if (data) setLog(data)
  }, [gitUrl])

  useEffect(() => {
    if (!isOpen) return
    fetchStatus()
    fetchLog()
  }, [isOpen, fetchStatus, fetchLog])

  useEffect(() => {
    if (!isOpen) {
      setCommitMsg('')
      setExpandedFile(null)
      setFileDiff(null)
      setDiscardConfirm(null)
      setReviewMode(false)
      setReviewDiffs(new Map())
      setCollapsedReviewFiles(new Set())
      setSelectedCommit(null)
      setCommitDiff(null)
      setCommitDiffError(false)
      setHunkDiscardConfirm(null)
    }
  }, [isOpen])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return
      if (e.key === 'Escape') {
        if (hunkDiscardConfirm) {
          setHunkDiscardConfirm(null)
        } else if (discardConfirm) {
          setDiscardConfirm(null)
        } else if (reviewMode) {
          setReviewMode(false)
          setSelectedCommit(null)
          setCommitDiff(null)
          setCommitDiffError(false)
        } else if (expandedFile) {
          setExpandedFile(null)
          setFileDiff(null)
        } else {
          onClose()
        }
        e.preventDefault()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose, expandedFile, discardConfirm, reviewMode, hunkDiscardConfirm])

  const toggleFileDiff = async (file: string, staged: boolean) => {
    const key = `${staged ? 's' : 'u'}:${file}`
    if (expandedFile === key) {
      setExpandedFile(null)
      setFileDiff(null)
      return
    }
    setExpandedFile(key)
    setDiffLoading(true)
    const data = await gitFetch<FileDiff>(
      gitUrl(`/api/git/file-diff?file=${encodeURIComponent(file)}&staged=${staged}`)
    )
    setFileDiff(data)
    setDiffLoading(false)
  }

  const withAction = async (fn: () => Promise<void>) => {
    if (actionInProgress) return
    setActionInProgress(true)
    await fn()
    await fetchStatus()
    setActionInProgress(false)
  }

  const handleStage = (files: string[]) => withAction(() => gitPost(gitUrl('/api/git/stage'), { files }).then(() => {}))
  const handleStageAll = () => withAction(() => gitPost(gitUrl('/api/git/stage'), { all: true }).then(() => {}))
  const handleUnstage = (files: string[]) => withAction(() => gitPost(gitUrl('/api/git/unstage'), { files }).then(() => {}))
  const handleUnstageAll = () => withAction(() => gitPost(gitUrl('/api/git/unstage'), { all: true }).then(() => {}))

  const confirmDiscard = (file: StatusFile) => setDiscardConfirm(file)
  const executeDiscard = () => {
    if (!discardConfirm) return
    const file = discardConfirm.file
    setDiscardConfirm(null)
    withAction(() => gitPost(gitUrl('/api/git/discard'), { files: [file] }).then(() => {}))
  }

  const handleHunkAction = async (filename: string, hunk: DiffHunk, action: 'stage' | 'unstage' | 'discard', fileStatus?: string) => {
    if (actionInProgress) return
    const url = gitUrl(action === 'stage' ? '/api/git/stage-hunk'
      : action === 'unstage' ? '/api/git/stage-hunk'
      : '/api/git/discard-hunk')

    const body = action === 'unstage'
      ? { patch: buildHunkPatch(filename, invertHunk(hunk), fileStatus) }
      : { patch: buildHunkPatch(filename, hunk, fileStatus) }

    setActionInProgress(true)
    await gitPost(url, body)
    await fetchStatus()

    if (expandedFile) {
      const [prefix, file] = [expandedFile[0], expandedFile.substring(2)]
      const staged = prefix === 's'
      const updated = await gitFetch<FileDiff>(
        gitUrl(`/api/git/file-diff?file=${encodeURIComponent(file)}&staged=${staged}`)
      )
      setFileDiff(updated)
    }

    if (reviewMode && !selectedCommit) {
      await loadReviewDiffs()
    }

    setActionInProgress(false)
  }

  const handleCommit = async () => {
    if (actionInProgress || !commitMsg.trim()) return
    const hasStaged = (status?.staged.length ?? 0) > 0
    const hasUnstaged = (status?.unstaged.length ?? 0) > 0
    if (!hasStaged && !hasUnstaged) return

    setActionInProgress(true)
    if (!hasStaged && hasUnstaged) {
      await gitPost(gitUrl('/api/git/stage'), { all: true })
    }
    const result = await gitPost(gitUrl('/api/git/commit'), { message: commitMsg.trim() })
    if (result?.success) {
      setCommitMsg('')
      await fetchStatus()
      await fetchLog()
    }
    setActionInProgress(false)
  }

  const loadReviewDiffs = useCallback(async () => {
    if (!status) return
    setReviewLoading(true)
    const allFiles = [...status.unstaged, ...status.staged]
    const uniqueFiles = [...new Map(allFiles.map(f => [f.file, f])).values()]
    const batchEntries = uniqueFiles.map(f => ({
      file: f.file,
      staged: status.staged.some(s => s.file === f.file),
    }))

    const result = await gitFetch<Record<string, FileDiff>>(gitUrl('/api/git/batch-file-diff'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: batchEntries }),
    })

    const diffs = new Map<string, FileDiff>()
    if (result) {
      for (const [file, diff] of Object.entries(result)) {
        diffs.set(file, diff)
      }
    }
    setReviewDiffs(diffs)
    setReviewLoading(false)
  }, [gitUrl, status])

  const enterReviewMode = async () => {
    setSelectedCommit(null)
    setCommitDiff(null)
    setCommitDiffError(false)
    setCollapsedReviewFiles(new Set(allFiles.map(file => file.file)))
    setReviewMode(true)
    await loadReviewDiffs()
  }

  const enterCommitReview = async (entry: GitLogEntry) => {
    setSelectedCommit(entry)
    setCommitDiff(null)
    setCommitDiffError(false)
    setCollapsedReviewFiles(new Set())
    setReviewLoading(true)
    setReviewMode(true)
    const params = new URLSearchParams({ hash: entry.hash, context: entry.context })
    const data = await gitFetch<DiffResult>(gitUrl(`/api/git/commit-diff?${params.toString()}`))
    if (data) {
      setCommitDiff(data)
      setCollapsedReviewFiles(new Set(data.files.map(file => file.filename)))
    } else {
      setCommitDiffError(true)
    }
    setReviewLoading(false)
  }

  const closeReviewMode = () => {
    setReviewMode(false)
    setSelectedCommit(null)
    setCommitDiff(null)
    setCommitDiffError(false)
    setCollapsedReviewFiles(new Set())
    setHunkDiscardConfirm(null)
  }

  const allFiles = useMemo(() => {
    if (!status) return []
    return [...new Map([...status.unstaged, ...status.staged].map(f => [f.file, f])).values()]
  }, [status])

  const reviewFiles = useMemo<StatusFile[]>(() => {
    if (selectedCommit) {
      return (commitDiff?.files ?? []).map(file => ({ file: file.filename, status: file.status }))
    }
    return allFiles
  }, [selectedCommit, commitDiff, allFiles])

  const activeReviewDiffs = useMemo(() => {
    if (!selectedCommit) return reviewDiffs
    return new Map((commitDiff?.files ?? []).map(file => [file.filename, file]))
  }, [selectedCommit, commitDiff, reviewDiffs])

  const toggleReviewFile = (filePath: string) => {
    setCollapsedReviewFiles(previous => {
      const next = new Set(previous)
      if (next.has(filePath)) {
        next.delete(filePath)
      } else {
        next.add(filePath)
      }
      return next
    })
  }

  const allReviewFilesCollapsed = reviewFiles.length > 0 && collapsedReviewFiles.size === reviewFiles.length
  const toggleAllReviewFiles = () => {
    setCollapsedReviewFiles(
      allReviewFilesCollapsed
        ? new Set()
        : new Set(reviewFiles.map(file => file.file))
    )
  }

  if (!isOpen) return null

  const staged = status?.staged ?? []
  const unstaged = status?.unstaged ?? []
  const hasStaged = staged.length > 0
  const hasUnstaged = unstaged.length > 0
  const canCommit = !actionInProgress && !!commitMsg.trim() && (hasStaged || hasUnstaged)
  const totalChanged = allFiles.length
  const reviewTotal = reviewFiles.length

  const commitLabel = hasStaged
    ? `Commit ${staged.length} file${staged.length > 1 ? 's' : ''}`
    : hasUnstaged
      ? `Commit All ${unstaged.length} file${unstaged.length > 1 ? 's' : ''}`
      : 'Commit'

  if (reviewMode) {
    return (
      <div className="fixed inset-0 z-50 bg-black/70 flex items-end justify-center">
        <div className="w-full h-[95vh] bg-bg-primary rounded-t-2xl flex flex-col overflow-hidden shadow-2xl">
          <div className="shrink-0 px-4 py-2.5 border-b border-border-subtle flex items-center justify-between bg-bg-secondary">
            <div className="flex items-center gap-2.5">
              <span className="text-[11px] font-semibold text-text-secondary tracking-widest uppercase">
                {selectedCommit ? `Commit ${selectedCommit.hash}` : 'Review Changes'}
              </span>
              <span className="text-[10px] bg-accent-blue/20 text-accent-blue px-1.5 py-0.5 rounded-full font-medium">{reviewTotal}</span>
            </div>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={toggleAllReviewFiles}
                disabled={reviewFiles.length === 0}
                className="px-2 py-1 text-[10px] font-medium text-text-secondary hover:text-text-primary hover:bg-[#30363d] rounded disabled:opacity-30 transition-colors"
              >
                {allReviewFilesCollapsed ? 'Expand All' : 'Collapse All'}
              </button>
              <IconBtn onClick={closeReviewMode} title="Back">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z"/></svg>
              </IconBtn>
            </div>
          </div>

          {selectedCommit && (
            <div className="shrink-0 px-3 py-2 border-b border-border-subtle bg-bg-primary">
              <div className="text-[12px] text-text-primary font-medium break-words">{selectedCommit.message}</div>
              <div className="mt-0.5 text-[10px] text-text-muted">{selectedCommit.author} · {selectedCommit.date}</div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto">
            {reviewLoading ? (
              <div className="px-4 py-8 text-center text-text-muted text-sm">Loading diffs...</div>
            ) : commitDiffError ? (
              <div className="px-4 py-8 text-center text-accent-red text-sm">Failed to load commit diff.</div>
            ) : reviewFiles.length === 0 ? (
              <div className="px-4 py-8 text-center text-text-muted text-sm">No changed files in this commit.</div>
            ) : (
              reviewFiles.map(f => {
                const diff = activeReviewDiffs.get(f.file)
                const isStaged = staged.some(s => s.file === f.file)
                const isCollapsed = collapsedReviewFiles.has(f.file)
                return (
                  <div key={f.file} id={`review-file-${f.file.replace(/[^a-zA-Z0-9]/g, '-')}`}>
                    <button
                      type="button"
                      onClick={() => toggleReviewFile(f.file)}
                      className="sticky top-0 z-10 w-full px-3 py-1.5 bg-[#161b22] hover:bg-[#1c2128] border-b border-[#21262d] flex items-center gap-2 text-left transition-colors"
                      aria-expanded={!isCollapsed}
                    >
                      <span className="text-[10px] text-text-muted w-3 shrink-0">{isCollapsed ? '▸' : '▾'}</span>
                      <span className={`text-[12px] font-medium ${STATUS_BADGE[f.status]?.text ?? 'text-text-secondary'}`}>
                        {f.file.split('/').pop()}
                      </span>
                      <span className="text-[11px] text-text-muted truncate flex-1">{f.file}</span>
                      {diff && (
                        <span className="text-[10px] text-text-muted">
                          <span className="text-accent-green">+{diff.additions}</span>{' '}
                          <span className="text-accent-red">-{diff.deletions}</span>
                        </span>
                      )}
                    </button>
                    {!isCollapsed && (
                      <InlineDiff
                        diff={diff ?? null}
                        loading={false}
                        filename={f.file}
                        staged={isStaged}
                        fileStatus={f.status}
                        onHunkAction={handleHunkAction}
                        onHunkDiscardConfirm={(filename, hunk) => setHunkDiscardConfirm({ filename, hunk })}
                        actionInProgress={actionInProgress}
                        readOnly={selectedCommit !== null}
                      />
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>

        {!selectedCommit && hunkDiscardConfirm && (
          <ConfirmDialog
            message="Are you sure you want to discard this hunk?"
            detail="This action is irreversible."
            confirmLabel="Discard"
            onConfirm={() => {
              const { filename, hunk } = hunkDiscardConfirm
              setHunkDiscardConfirm(null)
              handleHunkAction(filename, hunk, 'discard')
            }}
            onCancel={() => setHunkDiscardConfirm(null)}
          />
        )}
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-end justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full h-[90vh] bg-bg-primary rounded-t-2xl flex flex-col overflow-hidden shadow-2xl">
        <div className="shrink-0 px-4 py-2.5 border-b border-border-subtle flex items-center justify-between bg-bg-secondary">
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] font-semibold text-text-secondary tracking-widest uppercase">Source Control</span>
            {(hasStaged || hasUnstaged) && (
              <span className="text-[10px] bg-accent-blue/20 text-accent-blue px-1.5 py-0.5 rounded-full font-medium">
                {staged.length + unstaged.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            {totalChanged > 0 && (
              <button
                onClick={enterReviewMode}
                className="px-2 py-1 text-[10px] font-medium text-accent-blue bg-accent-blue/10 border border-accent-blue/30 rounded-md hover:bg-accent-blue/20 transition-colors mr-1"
              >
                Review All
              </button>
            )}
            <IconBtn onClick={() => { fetchStatus(); fetchLog() }} title="Refresh">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.45 2.55a8 8 0 0 0-11.8.7l-.9-.9A1 1 0 0 0 0 3v3.5a.5.5 0 0 0 .5.5H4a1 1 0 0 0 .7-1.7l-1-.95a5.5 5.5 0 0 1 8.28-.83 5.5 5.5 0 0 1 0 7.78 5.5 5.5 0 0 1-7.78 0 .75.75 0 1 0-1.06 1.06 7 7 0 0 0 9.9 0 7 7 0 0 0 .41-9.81z"/></svg>
            </IconBtn>
            <IconBtn onClick={onClose} title="Close">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z"/></svg>
            </IconBtn>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="px-3 pt-3 pb-1">
            <textarea
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  handleCommit()
                }
              }}
              placeholder={`Message (${navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to commit on "${status?.branch ?? '...'}")`}
              rows={1}
              className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded-md text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue/60 resize-none leading-5"
              style={{ minHeight: '36px' }}
              onInput={(e) => {
                const t = e.currentTarget
                t.style.height = 'auto'
                t.style.height = Math.min(t.scrollHeight, 120) + 'px'
              }}
            />
            <button
              onClick={handleCommit}
              disabled={!canCommit}
              className="mt-2 w-full py-2 rounded-md text-[13px] font-medium bg-accent-blue text-white hover:bg-[#4c9aff] active:bg-[#3d8bef] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              {commitLabel}
            </button>
          </div>

          <Section
            title="Staged Changes"
            count={staged.length}
            collapsed={stagedCollapsed}
            onToggle={() => setStagedCollapsed(p => !p)}
            actions={staged.length > 0 ? (
              <IconBtn onClick={handleUnstageAll} title="Unstage All" disabled={actionInProgress}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 8a.5.5 0 0 1 .5-.5h8a.5.5 0 0 1 0 1H4a.5.5 0 0 1-.5-.5z"/></svg>
              </IconBtn>
            ) : undefined}
          >
            {staged.length === 0 ? (
              <EmptyHint>No staged files</EmptyHint>
            ) : (
              staged.map((f) => (
                <FileRow
                  key={`s-${f.file}`}
                  file={f}
                  expanded={expandedFile === `s:${f.file}`}
                  onClickFile={() => toggleFileDiff(f.file, true)}
                  diff={expandedFile === `s:${f.file}` ? fileDiff : null}
                  diffLoading={expandedFile === `s:${f.file}` && diffLoading}
                  staged={true}
                  onHunkAction={handleHunkAction}
                  onHunkDiscardConfirm={(filename, hunk) => setHunkDiscardConfirm({ filename, hunk })}
                  actionInProgress={actionInProgress}
                  actions={
                    <IconBtn onClick={(e) => { e.stopPropagation(); handleUnstage([f.file]) }} title="Unstage" disabled={actionInProgress}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 8a.5.5 0 0 1 .5-.5h8a.5.5 0 0 1 0 1H4a.5.5 0 0 1-.5-.5z"/></svg>
                    </IconBtn>
                  }
                />
              ))
            )}
          </Section>

          <Section
            title="Changes"
            count={unstaged.length}
            collapsed={changesCollapsed}
            onToggle={() => setChangesCollapsed(p => !p)}
            actions={unstaged.length > 0 ? (
              <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
                <IconBtn onClick={handleStageAll} title="Stage All" disabled={actionInProgress}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3.5a.5.5 0 0 1 .5.5v3.5H12a.5.5 0 0 1 0 1H8.5V12a.5.5 0 0 1-1 0V8.5H4a.5.5 0 0 1 0-1h3.5V4a.5.5 0 0 1 .5-.5z"/></svg>
                </IconBtn>
              </div>
            ) : undefined}
          >
            {unstaged.length === 0 ? (
              <EmptyHint>No changes</EmptyHint>
            ) : (
              unstaged.map((f) => (
                <FileRow
                  key={`u-${f.file}`}
                  file={f}
                  expanded={expandedFile === `u:${f.file}`}
                  onClickFile={() => toggleFileDiff(f.file, false)}
                  diff={expandedFile === `u:${f.file}` ? fileDiff : null}
                  diffLoading={expandedFile === `u:${f.file}` && diffLoading}
                  staged={false}
                  onHunkAction={handleHunkAction}
                  onHunkDiscardConfirm={(filename, hunk) => setHunkDiscardConfirm({ filename, hunk })}
                  actionInProgress={actionInProgress}
                  actions={
                    <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
                      <IconBtn onClick={() => confirmDiscard(f)} title="Discard Changes" disabled={actionInProgress}>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4.4 2.9A6 6 0 0 1 14 8a.75.75 0 0 0 1.5 0 7.5 7.5 0 0 0-13-5.1V1.75a.75.75 0 0 0-1.5 0V5.5a.5.5 0 0 0 .5.5h3.75a.75.75 0 0 0 0-1.5H3.6a6 6 0 0 1 .8-1.6zM.5 8a.75.75 0 0 0-1.5 0 7.5 7.5 0 0 0 13 5.1v1.15a.75.75 0 0 0 1.5 0V10.5a.5.5 0 0 0-.5-.5H9.25a.75.75 0 0 0 0 1.5h1.65a6 6 0 0 1-.8 1.6A6 6 0 0 1 .5 8z"/></svg>
                      </IconBtn>
                      <IconBtn onClick={() => handleStage([f.file])} title="Stage Changes" disabled={actionInProgress}>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3.5a.5.5 0 0 1 .5.5v3.5H12a.5.5 0 0 1 0 1H8.5V12a.5.5 0 0 1-1 0V8.5H4a.5.5 0 0 1 0-1h3.5V4a.5.5 0 0 1 .5-.5z"/></svg>
                      </IconBtn>
                    </div>
                  }
                />
              ))
            )}
          </Section>

          <Section
            title="Commits"
            count={log.length}
            collapsed={commitsCollapsed}
            onToggle={() => setCommitsCollapsed(p => !p)}
          >
            {log.length === 0 ? (
              <EmptyHint>No commits</EmptyHint>
            ) : (
              log.map((entry) => (
                <button
                  key={entry.hash}
                  type="button"
                  onClick={() => enterCommitReview(entry)}
                  className="w-full px-3 py-1.5 hover:bg-[#1c2128] active:bg-[#21262d] flex items-baseline gap-2 text-left transition-colors"
                  title={`View changes in ${entry.hash}`}
                >
                  <span className="text-[11px] font-mono text-accent-purple shrink-0">{entry.hash}</span>
                  <span className="text-[12px] text-text-primary truncate flex-1">{entry.message}</span>
                  <span className="text-[10px] text-text-muted shrink-0 whitespace-nowrap">{entry.date}</span>
                </button>
              ))
            )}
          </Section>
        </div>
      </div>

      {discardConfirm && (
        <ConfirmDialog
          message={
            discardConfirm.status === 'U'
              ? 'Are you sure you want to delete this untracked file?'
              : 'Are you sure you want to discard changes in this file?'
          }
          detail={discardConfirm.file}
          subtext={discardConfirm.status !== 'U' ? 'This action is irreversible.' : undefined}
          confirmLabel={discardConfirm.status === 'U' ? 'Delete' : 'Discard'}
          onConfirm={executeDiscard}
          onCancel={() => setDiscardConfirm(null)}
        />
      )}

      {hunkDiscardConfirm && (
        <ConfirmDialog
          message="Are you sure you want to discard this hunk?"
          detail="This action is irreversible."
          confirmLabel="Discard"
          onConfirm={() => {
            const { filename, hunk } = hunkDiscardConfirm
            setHunkDiscardConfirm(null)
            handleHunkAction(filename, hunk, 'discard')
          }}
          onCancel={() => setHunkDiscardConfirm(null)}
        />
      )}
    </div>
  )
}

function invertHunk(hunk: DiffHunk): DiffHunk {
  const header = hunk.header.replace(
    /@@ -(\S+) \+(\S+) @@/,
    (_match, old_part: string, new_part: string) => `@@ -${new_part} +${old_part} @@`
  )
  return {
    header,
    lines: hunk.lines.map(l => ({
      ...l,
      type: l.type === 'add' ? 'del' : l.type === 'del' ? 'add' : 'ctx',
      old_num: l.new_num,
      new_num: l.old_num,
    })),
  }
}

const IconBtn: React.FC<{
  onClick: (e: React.MouseEvent) => void
  title: string
  disabled?: boolean
  children: React.ReactNode
}> = ({ onClick, title, disabled, children }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#30363d] text-text-secondary hover:text-text-primary disabled:opacity-30 transition-colors"
  >
    {children}
  </button>
)

const EmptyHint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-4 py-2.5 text-[12px] text-text-muted italic">{children}</div>
)

const Section: React.FC<{
  title: string
  count: number
  collapsed: boolean
  onToggle: () => void
  actions?: React.ReactNode
  children: React.ReactNode
}> = React.memo(({ title, count, collapsed, onToggle, actions, children }) => (
  <div className="border-t border-border-subtle">
    <div
      className="flex items-center justify-between px-3 py-1 bg-[#161b22] cursor-pointer hover:bg-[#1c2128] select-none"
      onClick={onToggle}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-text-muted w-3">{collapsed ? '▸' : '▾'}</span>
        <span className="text-[11px] font-semibold text-text-secondary">{title}</span>
        {count > 0 && (
          <span className="text-[10px] bg-[#30363d] text-text-secondary px-1.5 rounded-full font-medium min-w-[18px] text-center">
            {count}
          </span>
        )}
      </div>
      {!collapsed && actions && (
        <div onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      )}
    </div>
    {!collapsed && children}
  </div>
))

const FileRow: React.FC<{
  file: StatusFile
  expanded: boolean
  onClickFile: () => void
  diff: FileDiff | null
  diffLoading: boolean
  staged: boolean
  onHunkAction: (filename: string, hunk: DiffHunk, action: 'stage' | 'unstage' | 'discard', fileStatus?: string) => Promise<void>
  onHunkDiscardConfirm: (filename: string, hunk: DiffHunk) => void
  actionInProgress: boolean
  actions: React.ReactNode
}> = React.memo(({ file, expanded, onClickFile, diff, diffLoading, staged, onHunkAction, onHunkDiscardConfirm, actionInProgress, actions }) => {
  const filename = file.file.split('/').pop() ?? file.file
  const dir = file.file.includes('/') ? file.file.substring(0, file.file.lastIndexOf('/') + 1) : ''
  const badge = STATUS_BADGE[file.status] ?? { bg: 'bg-[#484f58]', text: 'text-[#484f58]' }

  return (
    <div>
      <div
        className={`flex items-center gap-1.5 pl-6 pr-2 py-[5px] cursor-pointer ${
          expanded ? 'bg-[#1c2128]' : 'hover:bg-[#1c2128]'
        }`}
        onClick={onClickFile}
      >
        <span className={`text-[12px] ${badge.text} shrink-0`}>{filename}</span>
        {dir && <span className="text-[11px] text-text-muted truncate">{dir}</span>}
        <div className="flex-1" />
        {actions}
        <span className={`text-[10px] ${badge.text} font-semibold w-4 text-center shrink-0`}>
          {file.status}
        </span>
      </div>
      {expanded && (
        <InlineDiff
          diff={diff}
          loading={diffLoading}
          filename={file.file}
          staged={staged}
          fileStatus={file.status}
          onHunkAction={onHunkAction}
          onHunkDiscardConfirm={onHunkDiscardConfirm}
          actionInProgress={actionInProgress}
        />
      )}
    </div>
  )
})

const InlineDiff: React.FC<{
  diff: FileDiff | null
  loading: boolean
  filename: string
  staged: boolean
  fileStatus?: string
  onHunkAction: (filename: string, hunk: DiffHunk, action: 'stage' | 'unstage' | 'discard', fileStatus?: string) => Promise<void>
  onHunkDiscardConfirm: (filename: string, hunk: DiffHunk) => void
  actionInProgress: boolean
  readOnly?: boolean
}> = React.memo(({ diff, loading, filename, staged, fileStatus, onHunkAction, onHunkDiscardConfirm, actionInProgress, readOnly = false }) => (
  <div className="bg-[#0d1117] overflow-x-auto max-h-[300px] overflow-y-auto border-y border-[#21262d]">
    {loading ? (
      <div className="px-4 py-3 text-[11px] text-text-muted">Loading diff...</div>
    ) : !diff || diff.hunks.length === 0 ? (
      <div className="px-4 py-3 text-[11px] text-text-muted">{diff?.binary ? 'Binary file' : 'No diff available'}</div>
    ) : (
      <table className="w-full text-[11px] font-mono border-collapse leading-[18px]">
        <tbody>
          {diff.hunks.map((hunk, hi) => (
            <React.Fragment key={hi}>
              <tr>
                <td colSpan={4} className="px-2 py-0.5 text-[#6e7681] bg-[#161b22] text-[10px] select-none">
                  <div className="flex items-center justify-between">
                    <span className="truncate">{hunk.header}</span>
                    {!diff.binary && !readOnly && (
                      <div className="flex items-center gap-1 shrink-0 ml-2">
                        {staged ? (
                          <HunkBtn
                            label="Unstage"
                            onClick={() => onHunkAction(filename, hunk, 'unstage', fileStatus)}
                            disabled={actionInProgress}
                            className="text-[#58a6ff]"
                          />
                        ) : (
                          <>
                            <HunkBtn
                              label="Discard"
                              onClick={() => onHunkDiscardConfirm(filename, hunk)}
                              disabled={actionInProgress}
                              className="text-accent-red"
                            />
                            <HunkBtn
                              label="Stage"
                              onClick={() => onHunkAction(filename, hunk, 'stage', fileStatus)}
                              disabled={actionInProgress}
                              className="text-accent-green"
                            />
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </td>
              </tr>
              {hunk.lines.map((line, li) => (
                <tr key={li} className={LINE_BG[line.type]}>
                  <td className={`pl-2 pr-1 text-right select-none w-[1%] whitespace-nowrap ${LINE_GUTTER[line.type]} opacity-50 text-[10px]`}>
                    {line.old_num ?? ''}
                  </td>
                  <td className={`px-1 text-right select-none w-[1%] whitespace-nowrap ${LINE_GUTTER[line.type]} opacity-50 text-[10px]`}>
                    {line.new_num ?? ''}
                  </td>
                  <td className={`px-0.5 select-none w-[1%] ${LINE_GUTTER[line.type]}`}>
                    {LINE_PREFIX[line.type]}
                  </td>
                  <td className="px-1 whitespace-pre text-[#e6edf3]">{line.content}</td>
                </tr>
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    )}
  </div>
))

const HunkBtn: React.FC<{
  label: string
  onClick: () => void
  disabled: boolean
  className?: string
}> = ({ label, onClick, disabled, className = '' }) => (
  <button
    onClick={(e) => { e.stopPropagation(); onClick() }}
    disabled={disabled}
    className={`px-1.5 py-0.5 text-[9px] font-medium rounded hover:bg-[#30363d] disabled:opacity-30 transition-colors ${className}`}
  >
    {label}
  </button>
)

const ConfirmDialog: React.FC<{
  message: string
  detail: string
  subtext?: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}> = ({ message, detail, subtext, confirmLabel, onConfirm, onCancel }) => (
  <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center px-4" onClick={onCancel}>
    <div className="bg-bg-secondary border border-border-subtle rounded-xl shadow-2xl max-w-sm w-full p-4" onClick={(e) => e.stopPropagation()}>
      <p className="text-[13px] text-text-primary leading-5">{message}</p>
      <p className="text-[12px] text-text-muted mt-1 font-mono truncate">{detail}</p>
      {subtext && <p className="text-[11px] text-text-muted mt-2">{subtext}</p>}
      <div className="flex items-center justify-end gap-2 mt-4">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-[12px] rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className="px-3 py-1.5 text-[12px] rounded-md bg-accent-red text-white hover:bg-accent-red/80 font-medium transition-colors"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
)
