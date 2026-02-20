import React, { useState, useRef, useEffect, useCallback } from 'react'

interface BranchData {
  local: string[]
  remote: string[]
  current: string
}

interface BranchSelectorProps {
  currentBranch: string
  onBranchChange?: () => void
}

export const BranchSelector: React.FC<BranchSelectorProps> = ({ currentBranch, onBranchChange }) => {
  const [isOpen, setIsOpen] = useState(false)
  const [branches, setBranches] = useState<BranchData>({ local: [], remote: [], current: '' })
  const [search, setSearch] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

   const fetchBranches = useCallback(async () => {
     setIsLoading(true)
     try {
       const res = await fetch(`/api/git/branches`, { signal: AbortSignal.timeout(5000) })
      if (res.ok) {
        const data = await res.json()
        setBranches(data)
      }
    } catch {
      setBranches({ local: [], remote: [], current: '' })
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOpen) {
      fetchBranches()
      setTimeout(() => inputRef.current?.focus(), 100)
    } else {
      setSearch('')
    }
  }, [isOpen, fetchBranches])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('touchstart', handleClickOutside, { passive: true })
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
        document.removeEventListener('touchstart', handleClickOutside)
      }
    }
  }, [isOpen])

   const handleCheckout = async (branch: string) => {
     setIsOpen(false)
     try {
       const url = `/api/git/checkout?branch=${encodeURIComponent(branch)}`
       const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
      if (res.ok) {
        onBranchChange?.()
      }
    } catch {}
  }

  const filterBranches = (list: string[]) => {
    if (!search) return list
    const lower = search.toLowerCase()
    return list.filter(b => b.toLowerCase().includes(lower))
  }

  const filteredLocal = filterBranches(branches.local)
  const filteredRemote = filterBranches(branches.remote)

  if (!currentBranch) return null

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="text-accent-purple hover:text-accent-purple/80 text-xs font-mono flex items-center gap-1"
      >
        <span>{currentBranch}</span>
        <span className="text-[10px] opacity-70">{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-bg-secondary border border-border-subtle rounded-lg shadow-lg z-50 overflow-hidden">
          <div className="p-2 border-b border-border-subtle">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search branches..."
              className="w-full px-2 py-1.5 bg-bg-tertiary border border-border-subtle rounded text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-purple"
            />
          </div>

          <div className="max-h-[300px] overflow-y-auto">
            {isLoading ? (
              <div className="p-4 text-center text-text-muted text-sm">Loading...</div>
            ) : (
              <>
                {filteredLocal.length > 0 && (
                  <div>
                    <div className="px-3 py-1.5 text-xs text-text-muted bg-bg-tertiary">Local</div>
                    {filteredLocal.map(branch => (
                      <button
                        key={branch}
                        onClick={() => handleCheckout(branch)}
                        className={`w-full px-3 py-2 text-left text-sm truncate ${
                          branch === branches.current
                            ? 'bg-accent-purple/20 text-accent-purple'
                            : 'text-text-primary hover:bg-bg-tertiary'
                        }`}
                      >
                        {branch === branches.current && <span className="mr-1">✓</span>}
                        {branch}
                      </button>
                    ))}
                  </div>
                )}

                {filteredRemote.length > 0 && (
                  <div>
                    <div className="px-3 py-1.5 text-xs text-text-muted bg-bg-tertiary">Remote</div>
                    {filteredRemote.map(branch => (
                      <button
                        key={branch}
                        onClick={() => handleCheckout(branch)}
                        className="w-full px-3 py-2 text-left text-sm text-text-secondary hover:bg-bg-tertiary truncate"
                      >
                        {branch}
                      </button>
                    ))}
                  </div>
                )}

                {filteredLocal.length === 0 && filteredRemote.length === 0 && (
                  <div className="p-4 text-center text-text-muted text-sm">No branches found</div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
