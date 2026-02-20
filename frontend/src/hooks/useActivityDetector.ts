import { useState, useEffect, useCallback, useRef } from 'react'
import { useTerminal } from '../contexts/TerminalContext'
import ActivityWorker from '../workers/activity-worker.ts?worker&inline'

export type ActivityType = 'reading' | 'writing' | 'thinking' | 'executing' | 'complete' | 'error'

export interface Activity {
  id: string
  type: ActivityType
  message: string
  file?: string
  timestamp: Date
}

const MAX_ACTIVITIES = 10

export function useActivityDetector() {
  const [activities, setActivities] = useState<Activity[]>([])
  const { subscribeOutput } = useTerminal()
  const idCounterRef = useRef(0)
  const workerRef = useRef<Worker | null>(null)

  const addActivity = useCallback((type: ActivityType, message: string, file?: string) => {
    const newActivity: Activity = {
      id: `activity-${++idCounterRef.current}`,
      type,
      message,
      file,
      timestamp: new Date(),
    }
    
    setActivities(prev => {
      const updated = [newActivity, ...prev]
      return updated.slice(0, MAX_ACTIVITIES)
    })
  }, [])

  useEffect(() => {
    const worker = new ActivityWorker()
    workerRef.current = worker

    worker.onmessage = (e: MessageEvent<{ type: string; activities: Array<{ type: ActivityType; message: string; file?: string }> }>) => {
      if (e.data.type === 'activity') {
        for (const act of e.data.activities) {
          addActivity(act.type, act.message, act.file)
        }
      }
    }

    const unsubscribe = subscribeOutput((data) => {
      const text = typeof data === 'string'
        ? data
        : new TextDecoder().decode(data)

      worker.postMessage({ type: 'data', payload: text })
    })

    return () => {
      unsubscribe()
      worker.terminate()
      workerRef.current = null
    }
  }, [subscribeOutput, addActivity])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as unknown as { __addMockActivity: typeof addActivity }).__addMockActivity = addActivity
    }
    return () => {
      if (typeof window !== 'undefined') {
        delete (window as unknown as { __addMockActivity?: typeof addActivity }).__addMockActivity
      }
    }
  }, [addActivity])

  return { activities, addActivity }
}
