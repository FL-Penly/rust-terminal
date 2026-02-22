import { describe, it, expect } from 'vitest'

describe('TextEncoder singleton pattern', () => {
  it('new TextEncoder produces same bytes as singleton', () => {
    const singleton = new TextEncoder()
    const text = 'hello world'
    const fromSingleton = singleton.encode(text)
    const fromNew = new TextEncoder().encode(text)
    expect(Array.from(fromSingleton)).toEqual(Array.from(fromNew))
  })

  it('encodes control bytes correctly', () => {
    const encoder = new TextEncoder()
    const result = encoder.encode('\x03')
    expect(result[0]).toBe(3)
  })

  it('encodes empty string to empty array', () => {
    const encoder = new TextEncoder()
    const result = encoder.encode('')
    expect(result.length).toBe(0)
  })

  it('encodes multi-byte UTF-8 correctly', () => {
    const encoder = new TextEncoder()
    const result = encoder.encode('€')
    expect(result.length).toBe(3)
    expect(result[0]).toBe(0xe2)
    expect(result[1]).toBe(0x82)
    expect(result[2]).toBe(0xac)
  })
})

describe('TextDecoder singleton pattern', () => {
  it('cached decoder produces same string as new instance', () => {
    const cached = new TextDecoder()
    const data = new Uint8Array([104, 101, 108, 108, 111])
    const fromCached = cached.decode(data)
    const fromNew = new TextDecoder().decode(data)
    expect(fromCached).toBe(fromNew)
    expect(fromCached).toBe('hello')
  })

  it('stream:false (default) handles complete sequences', () => {
    const decoder = new TextDecoder()
    const utf8 = new Uint8Array([0xe4, 0xb8, 0xad])
    expect(decoder.decode(utf8)).toBe('中')
  })

  it('decodes empty input to empty string', () => {
    const decoder = new TextDecoder()
    expect(decoder.decode(new Uint8Array([]))).toBe('')
  })
})

describe('Backspace sequence cache pattern', () => {
  it('repeat result is consistent for same length', () => {
    const seq = '\b \b'
    const len = 5
    const first = seq.repeat(len)
    const second = seq.repeat(len)
    expect(first).toBe(second)
    expect(first.length).toBe(15)
  })

  it('repeat(0) returns empty string', () => {
    expect('\b \b'.repeat(0)).toBe('')
  })
})
