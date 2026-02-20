const ANSI_REGEX = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, '')
}

type ActivityType = 'reading' | 'writing' | 'thinking' | 'executing' | 'complete' | 'error'

interface PatternDef {
  pattern: RegExp
  type: ActivityType
  fileGroup?: number
}

const PATTERNS: PatternDef[] = [
  { pattern: /^Reading\s+(.+)$/i, type: 'reading', fileGroup: 1 },
  { pattern: /^Wrote\s+(.+?)(?:\s+\(.*\))?$/i, type: 'writing', fileGroup: 1 },
  { pattern: /^Created\s+(.+)$/i, type: 'writing', fileGroup: 1 },
  { pattern: /^Edited\s+(.+)$/i, type: 'writing', fileGroup: 1 },
  { pattern: /^Running\s+(.+)$/i, type: 'executing', fileGroup: 1 },
  { pattern: /^Executing\s+(.+)$/i, type: 'executing', fileGroup: 1 },
  { pattern: /^Thinking\.{3}$/i, type: 'thinking' },
  { pattern: /^Analyzing\s+(.+)/i, type: 'thinking', fileGroup: 1 },
  { pattern: /^\[read\]\s+(.+)$/i, type: 'reading', fileGroup: 1 },
  { pattern: /^\[write\]\s+(.+)$/i, type: 'writing', fileGroup: 1 },
  { pattern: /^\[exec\]\s+(.+)$/i, type: 'executing', fileGroup: 1 },
  { pattern: /^✓\s+(.+)$/i, type: 'complete', fileGroup: 1 },
  { pattern: /^✗\s+(.+)$/i, type: 'error', fileGroup: 1 },
  { pattern: /^Error:\s+(.+)/i, type: 'error', fileGroup: 1 },
]

const BUFFER_LIMIT = 1000

let buffer = ''

function processLine(line: string): { type: ActivityType; message: string; file?: string } | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  for (const { pattern, type, fileGroup } of PATTERNS) {
    const match = trimmed.match(pattern)
    if (match) {
      const file = fileGroup ? match[fileGroup] : undefined
      const message = file || trimmed
      return { type, message, file }
    }
  }
  return null
}

self.onmessage = (e: MessageEvent<{ type: string; payload: string }>) => {
  if (e.data.type !== 'data') return

  const cleaned = stripAnsi(e.data.payload)
  buffer += cleaned

  if (buffer.length > BUFFER_LIMIT) {
    buffer = buffer.slice(-BUFFER_LIMIT)
  }

  const lines = buffer.split(/\r?\n/)
  buffer = lines.pop() || ''

  const linesToProcess = lines.slice(0, 50)
  const activities: { type: ActivityType; message: string; file?: string }[] = []

  for (const line of linesToProcess) {
    const result = processLine(line)
    if (result) activities.push(result)
  }

  if (activities.length > 0) {
    self.postMessage({ type: 'activity', activities })
  }
}
