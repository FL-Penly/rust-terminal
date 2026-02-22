import type { Terminal } from '@xterm/xterm'

const DIM_START = '\x1b[2m'
const DIM_END = '\x1b[22m'

function isPrintable(char: string): boolean {
  const code = char.charCodeAt(0)
  return code >= 0x20 && code <= 0x7E
}

export class PredictiveEcho {
  private term: Terminal
  private predicted: string[] = []
  private _enabled = false
  private altScreen = false
  private readonly decoder = new TextDecoder()
  private erasureCache = ''
  private erasureCacheLen = 0

  constructor(term: Terminal) {
    this.term = term
  }

  private getErasure(len: number): string {
    if (len !== this.erasureCacheLen) {
      this.erasureCache = '\b \b'.repeat(len)
      this.erasureCacheLen = len
    }
    return this.erasureCache
  }

  get enabled(): boolean {
    return this._enabled
  }

  set enabled(value: boolean) {
    this._enabled = value
    if (!value) this.reset()
  }

  setAltScreen(active: boolean): void {
    this.altScreen = active
    if (active) this.reset()
  }

  handleInput(data: string): void {
    if (!this._enabled || this.altScreen) return

    if (data.length > 1) {
      this.reset()
      return
    }

    for (const char of data) {
      if (char === '\r' || char === '\n') {
        this.reset()
        return
      }

      if (char === '\x7f' || char === '\b') {
        if (this.predicted.length > 0) {
          this.predicted.pop()
          this.term.write('\b \b')
        }
        return
      }

      if (!isPrintable(char)) {
        this.reset()
        return
      }

      this.predicted.push(char)
      this.term.write(`${DIM_START}${char}${DIM_END}`)
    }
  }

  handleOutput(data: Uint8Array): void {
    if (!this._enabled || this.predicted.length === 0) return

    const text = this.decoder.decode(data)
    let matchCount = 0

    for (let i = 0; i < text.length && matchCount < this.predicted.length; i++) {
      if (text[i] === this.predicted[matchCount]) {
        matchCount++
      } else {
        break
      }
    }

    if (matchCount > 0) {
      this.term.write(this.getErasure(this.predicted.length))
      this.predicted.splice(0, matchCount)
    } else if (this.predicted.length > 0) {
      this.term.write(this.getErasure(this.predicted.length))
      this.predicted = []
    }
  }

  isActive(): boolean {
    return this.predicted.length > 0
  }

  reset(): void {
    if (this.predicted.length > 0) {
      this.term.write(this.getErasure(this.predicted.length))
      this.predicted = []
    }
  }
}
