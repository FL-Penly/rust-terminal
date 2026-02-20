import React, { useState, useEffect, useCallback, useRef } from 'react'
import ReactDiffViewer from 'react-diff-viewer-continued'

interface DiffFile {
  filename: string
  status: 'A' | 'M' | 'D'
  additions: number
  deletions: number
  oldValue?: string
  newValue?: string
  binary?: boolean
}

interface DiffData {
  branch?: string
  git_root?: string
  cwd?: string
  summary?: {
    totalFiles: number
    totalAdditions: number
    totalDeletions: number
  }
  files?: DiffFile[]
  error?: string
  message?: string
}

interface DiffViewerProps {
  isOpen: boolean
  onClose: () => void
}

const darkTheme = {
  variables: {
    dark: {
      diffViewerBackground: '#0d1117',
      diffViewerColor: '#e6edf3',
      addedBackground: 'rgba(63, 185, 80, 0.15)',
      addedColor: '#e6edf3',
      removedBackground: 'rgba(248, 81, 73, 0.15)',
      removedColor: '#e6edf3',
      wordAddedBackground: 'rgba(63, 185, 80, 0.4)',
      wordRemovedBackground: 'rgba(248, 81, 73, 0.4)',
      addedGutterBackground: '#1a4d2e',
      removedGutterBackground: '#4d1a1a',
      gutterBackground: '#161b22',
      gutterBackgroundDark: '#0d1117',
      highlightBackground: '#21262d',
      highlightGutterBackground: '#21262d',
      codeFoldGutterBackground: '#161b22',
      codeFoldBackground: '#161b22',
      emptyLineBackground: '#161b22',
      gutterColor: '#6e7681',
      addedGutterColor: '#3fb950',
      removedGutterColor: '#f85149',
      codeFoldContentColor: '#8b949e',
      diffViewerTitleBackground: '#161b22',
      diffViewerTitleColor: '#e6edf3',
      diffViewerTitleBorderColor: '#30363d',
    }
  }
}

const STATUS_LABELS: Record<string, string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
}

const STATUS_COLORS: Record<string, string> = {
  A: 'bg-accent-green text-white',
  M: 'bg-accent-blue text-white',
  D: 'bg-accent-red text-white',
}

function isChangeRow(row: Element): boolean {
  const cells = row.querySelectorAll('td')
  for (const cell of cells) {
    const pre = cell.querySelector('pre')
    if (pre) {
      const text = pre.textContent?.trim()
      if (text === '+' || text === '-') return true
    }
  }
  return false
}

function isFoldRow(row: Element): boolean {
  return row.textContent?.includes('hidden lines') || false
}

function collectHunks(container: HTMLElement): Element[] {
  const hunks: Element[] = []
  const rows = Array.from(container.querySelectorAll('tr'))
  let prevWasChange = false
  
  for (const row of rows) {
    if (isFoldRow(row)) {
      prevWasChange = false
      continue
    }
    
    const isChange = isChangeRow(row)
    if (isChange && !prevWasChange) {
      hunks.push(row)
    }
    prevWasChange = isChange
  }
  
  return hunks
}

interface FileCardProps {
  file: DiffFile
  defaultExpanded: boolean
}

function FileCard({ file, defaultExpanded }: FileCardProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const [currentHunkIndex, setCurrentHunkIndex] = useState(-1)
  const [totalHunks, setTotalHunks] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const hunksRef = useRef<Element[]>([])

  useEffect(() => {
    if (isExpanded && contentRef.current) {
      const timer = setTimeout(() => {
        if (contentRef.current) {
          hunksRef.current = collectHunks(contentRef.current)
          setTotalHunks(hunksRef.current.length)
          setCurrentHunkIndex(hunksRef.current.length > 0 ? 0 : -1)
        }
      }, 200)
      return () => clearTimeout(timer)
    } else {
      hunksRef.current = []
      setTotalHunks(0)
      setCurrentHunkIndex(-1)
    }
  }, [isExpanded])

  const navigateHunk = (direction: 'prev' | 'next') => {
    if (hunksRef.current.length === 0) return
    
    let newIndex: number
    if (direction === 'prev') {
      newIndex = Math.max(0, currentHunkIndex - 1)
    } else {
      newIndex = Math.min(hunksRef.current.length - 1, currentHunkIndex + 1)
    }
    
    if (newIndex !== currentHunkIndex) {
      setCurrentHunkIndex(newIndex)
      hunksRef.current[newIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  return (
    <div className="border border-border-subtle rounded-lg overflow-hidden mb-3">
      <div className="flex items-center justify-between px-3 py-2 bg-bg-tertiary">
        <div 
          className="flex items-center gap-2 min-w-0 cursor-pointer flex-1"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <span className="text-text-secondary shrink-0">{isExpanded ? '▼' : '▶'}</span>
          <span className="text-sm truncate">{file.filename}</span>
          <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${STATUS_COLORS[file.status] || 'bg-bg-secondary'}`}>
            {STATUS_LABELS[file.status] || file.status}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-text-secondary">
            {file.additions > 0 && <span className="text-accent-green mr-1">+{file.additions}</span>}
            {file.deletions > 0 && <span className="text-accent-red">-{file.deletions}</span>}
          </span>
          {isExpanded && totalHunks > 0 && (
            <div className="flex items-center gap-1 ml-2">
              <button
                onClick={(e) => { e.stopPropagation(); navigateHunk('prev'); }}
                disabled={currentHunkIndex <= 0}
                className="w-6 h-6 flex items-center justify-center rounded bg-bg-secondary text-text-secondary hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
              >
                ↑
              </button>
              <span className="text-xs text-text-muted min-w-[32px] text-center">
                {currentHunkIndex + 1}/{totalHunks}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); navigateHunk('next'); }}
                disabled={currentHunkIndex >= totalHunks - 1}
                className="w-6 h-6 flex items-center justify-center rounded bg-bg-secondary text-text-secondary hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
              >
                ↓
              </button>
            </div>
          )}
        </div>
      </div>
      
      {isExpanded && (
        <div ref={contentRef} className="overflow-x-auto max-h-[400px] overflow-y-auto">
          {file.binary ? (
            <div className="p-4 text-center text-text-muted">Binary file</div>
          ) : (
            <ReactDiffViewer
              oldValue={file.oldValue || ''}
              newValue={file.newValue || ''}
              splitView={false}
              useDarkTheme={true}
              styles={darkTheme}
              showDiffOnly={true}
              extraLinesSurroundingDiff={3}
              codeFoldMessageRenderer={(total) => <span>{total} hidden lines</span>}
            />
          )}
        </div>
      )}
    </div>
  )
}

export const DiffViewer: React.FC<DiffViewerProps> = ({ isOpen, onClose }) => {
  const [data, setData] = useState<DiffData | null>(null)
  const [isLoading, setIsLoading] = useState(false)

   const fetchDiff = useCallback(async () => {
     setIsLoading(true)
     try {
       const response = await fetch(`/api/diff`, { signal: AbortSignal.timeout(5000) })
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      
      const json = await response.json()
      setData(json)
    } catch (err) {
      setData({
        error: 'connection_failed',
        message: err instanceof Error ? err.message : 'Cannot connect to diff server'
      })
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOpen) {
      fetchDiff()
    }
  }, [isOpen, fetchDiff])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return
      if (e.key === 'Escape') {
        onClose()
        e.preventDefault()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const files = data?.files || []
  const totalFiles = files.length
  const totalAdditions = data?.summary?.totalAdditions || 0
  const totalDeletions = data?.summary?.totalDeletions || 0

  return (
    <div 
      className="fixed inset-0 z-50 bg-black/80 flex items-end justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full h-[90vh] bg-bg-primary rounded-t-2xl flex flex-col overflow-hidden">
        <div className="shrink-0 px-4 py-3 border-b border-border-subtle flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold">Git Diff</h2>
            {data?.branch && (
              <span className="text-sm text-accent-purple">{data.branch}</span>
            )}
          </div>
          <button 
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-bg-tertiary text-text-secondary"
          >
            ✕
          </button>
        </div>
        
        <div className="shrink-0 px-4 py-2 border-b border-border-subtle flex items-center justify-between text-xs text-text-secondary">
          <div className="flex items-center gap-3">
            {data?.git_root && (
              <span className="truncate max-w-[200px]" title={data.git_root}>
                {data.git_root}
              </span>
            )}
            <span>{totalFiles} file{totalFiles !== 1 ? 's' : ''}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-accent-green">+{totalAdditions}</span>
            <span className="text-accent-red">-{totalDeletions}</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-text-muted">Loading...</div>
            </div>
          ) : data?.error ? (
            <div className="flex flex-col items-center justify-center h-full gap-2">
              <span className="text-2xl">⚠️</span>
              <span className="text-text-muted">{data.message || 'Error loading diff'}</span>
            </div>
          ) : files.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2">
              <span className="text-2xl text-accent-green">✓</span>
              <span className="text-text-muted">No changes</span>
            </div>
          ) : (
            files.map((file, index) => (
              <FileCard
                key={file.filename}
                file={file}
                defaultExpanded={index === 0}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
