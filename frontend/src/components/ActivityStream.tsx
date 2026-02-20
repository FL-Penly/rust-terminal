import React, { useState } from 'react'
import { useActivityDetector, ActivityType } from '../hooks/useActivityDetector'

const ICONS: Record<ActivityType, string> = {
  reading: '📖',
  writing: '✏️',
  thinking: '🧠',
  executing: '▶️',
  complete: '✓',
  error: '✗',
}

const TYPE_COLORS: Record<ActivityType, string> = {
  reading: 'text-text-secondary',
  writing: 'text-accent-green',
  thinking: 'text-accent-purple',
  executing: 'text-accent-blue',
  complete: 'text-accent-green',
  error: 'text-accent-red',
}

export const ActivityStream: React.FC = () => {
  const [isExpanded, setIsExpanded] = useState(false)
  const { activities } = useActivityDetector()

  const hasActivities = activities.length > 0
  const latestActivity = activities[0]

  if (!hasActivities && !isExpanded) {
    return (
      <div 
        className="shrink-0 bg-bg-secondary border-b border-border-subtle cursor-pointer"
        onClick={() => setIsExpanded(true)}
      >
        <div className="px-3 py-2 text-xs text-text-muted flex items-center gap-2">
          <span>▶</span>
          <span>No recent activity</span>
        </div>
      </div>
    )
  }

  if (!isExpanded) {
    return (
      <div 
        className="shrink-0 bg-bg-secondary border-b border-border-subtle cursor-pointer"
        onClick={() => setIsExpanded(true)}
      >
        <div className="px-3 py-2 text-xs flex items-center gap-2">
          <span className="text-text-muted">▶</span>
          <span className="text-text-secondary">{activities.length} activities</span>
          {latestActivity && (
            <>
              <span className="text-border-subtle">│</span>
              <span className={TYPE_COLORS[latestActivity.type]}>
                {ICONS[latestActivity.type]} {latestActivity.message}
              </span>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="shrink-0 bg-bg-secondary border-b border-border-subtle max-h-[200px] overflow-y-auto">
      <div 
        className="px-3 py-2 text-xs text-text-muted flex items-center gap-2 cursor-pointer sticky top-0 bg-bg-secondary border-b border-border-subtle"
        onClick={() => setIsExpanded(false)}
      >
        <span>▼</span>
        <span>{activities.length} activities</span>
      </div>
      
      <div className="divide-y divide-border-subtle">
        {activities.map((activity, index) => {
          const isLatest = index === 0 && (activity.type === 'reading' || activity.type === 'thinking' || activity.type === 'executing')
          
          return (
            <div 
              key={activity.id}
              className={`px-3 py-2 text-xs flex items-center gap-2 ${
                isLatest ? 'bg-glow-ai border-l-2 border-accent-purple' : ''
              }`}
              style={isLatest ? { boxShadow: '0 0 12px var(--glow-ai)' } : undefined}
            >
              <span className={TYPE_COLORS[activity.type]}>
                {ICONS[activity.type]}
              </span>
              <span className="text-text-primary truncate flex-1">
                {activity.message}
              </span>
              {activity.file && activity.file !== activity.message && (
                <span className="text-text-muted truncate max-w-[120px]" title={activity.file}>
                  {activity.file}
                </span>
              )}
              <span className="text-text-muted shrink-0">
                {formatTime(activity.timestamp)}
              </span>
            </div>
          )
        })}
      </div>
      
      {!hasActivities && (
        <div className="px-3 py-4 text-xs text-text-muted text-center">
          No recent activity
        </div>
      )}
    </div>
  )
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit',
    second: '2-digit',
    hour12: false 
  })
}
