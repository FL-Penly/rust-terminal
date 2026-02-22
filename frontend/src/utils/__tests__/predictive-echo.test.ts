import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PredictiveEcho } from '../predictive-echo'
import type { Terminal } from '@xterm/xterm'

describe('PredictiveEcho', () => {
  let writtenData: string[]
  let mockTerm: Terminal
  let echo: PredictiveEcho

  beforeEach(() => {
    writtenData = []
    mockTerm = {
      write: vi.fn((data: string) => writtenData.push(data)),
      buffer: { active: { type: 'normal' } },
    } as unknown as Terminal
    echo = new PredictiveEcho(mockTerm)
    echo.enabled = true
  })

  it('shows dim prediction for printable char', () => {
    echo.handleInput('a')
    expect(mockTerm.write).toHaveBeenCalled()
    const written = writtenData.join('')
    expect(written).toContain('a')
  })

  it('handles backspace by removing last predicted char', () => {
    echo.handleInput('a')
    echo.handleInput('\x7f')
    const written = writtenData.join('')
    expect(written).toContain('\b \b')
  })

  it('resets on Enter', () => {
    echo.handleInput('a')
    echo.handleInput('b')
    echo.handleInput('\r')
    expect(echo.isActive()).toBe(false)
  })

  it('resets on non-printable control char', () => {
    echo.handleInput('a')
    echo.handleInput('\x03')
    expect(echo.isActive()).toBe(false)
  })

  it('does nothing when disabled', () => {
    echo.enabled = false
    echo.handleInput('a')
    expect(mockTerm.write).not.toHaveBeenCalled()
  })

  it('does nothing when alt screen active', () => {
    echo.setAltScreen(true)
    echo.handleInput('a')
    expect(mockTerm.write).not.toHaveBeenCalled()
  })

  it('resets on entering alt screen', () => {
    echo.handleInput('a')
    expect(echo.isActive()).toBe(true)
    echo.setAltScreen(true)
    expect(echo.isActive()).toBe(false)
  })

  it('resumes predictions after leaving alt screen', () => {
    echo.setAltScreen(true)
    echo.setAltScreen(false)
    echo.handleInput('a')
    expect(echo.isActive()).toBe(true)
  })

  it('skips prediction for multi-char input (paste protection)', () => {
    echo.handleInput('abc')
    expect(echo.isActive()).toBe(false)
  })

  it('erases predictions when server output matches', () => {
    echo.handleInput('a')
    const matchData = new TextEncoder().encode('a')
    echo.handleOutput(matchData)
    expect(echo.isActive()).toBe(false)
  })

  it('erases all predictions on mismatch', () => {
    echo.handleInput('a')
    echo.handleInput('b')
    const mismatch = new TextEncoder().encode('x')
    echo.handleOutput(mismatch)
    expect(echo.isActive()).toBe(false)
  })
})
