import { useState, useEffect, useCallback } from 'react'

const POLL_INTERVAL = 5000

interface StatusState {
  branch: string
  path: string
  changedFiles: number
  additions: number
  deletions: number
  isLoading: boolean
  error: string | null
  isOffline: boolean
}

interface StatusData extends StatusState {
  refresh: () => void
}

export function useStatusData(): StatusData {
  const [data, setData] = useState<StatusState>({
    branch: '',
    path: '',
    changedFiles: 0,
    additions: 0,
    deletions: 0,
    isLoading: true,
    error: null,
    isOffline: false,
  })

   const fetchData = useCallback(async () => {
     try {
       const response = await fetch(`/api/diff`, { signal: AbortSignal.timeout(3000) })
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      
      const json = await response.json()
      
      setData({
        branch: json.branch || 'unknown',
        path: json.git_root || json.cwd || '~',
        changedFiles: json.summary?.totalFiles || 0,
        additions: json.summary?.totalAdditions || 0,
        deletions: json.summary?.totalDeletions || 0,
        isLoading: false,
        error: null,
        isOffline: false,
      })
    } catch (err) {
      setData(prev => ({
        ...prev,
        isLoading: false,
        isOffline: true,
        error: err instanceof Error ? err.message : 'Unknown error',
      }))
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchData])

  return { ...data, refresh: fetchData }
}
