import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_IDLE_EMPTY_RECLAIM_MS,
  MAX_TERMINAL_IDLE_EMPTY_RECLAIM_MS,
  MIN_TERMINAL_IDLE_EMPTY_RECLAIM_MS,
  isTerminalIdleEmptyReclaimEligible,
  normalizeTerminalCreationOrigin,
  normalizeTerminalIdleEmptyReclaimMs
} from './terminal-idle-reclaim'

describe('terminal idle reclaim policy', () => {
  it('normalizes only known origins', () => {
    expect(normalizeTerminalCreationOrigin('cli')).toBe('cli')
    expect(normalizeTerminalCreationOrigin('unknown')).toBeUndefined()
    expect(normalizeTerminalCreationOrigin(undefined)).toBeUndefined()
  })

  it('clamps the configured threshold and defaults invalid values', () => {
    expect(normalizeTerminalIdleEmptyReclaimMs(1)).toBe(MIN_TERMINAL_IDLE_EMPTY_RECLAIM_MS)
    expect(normalizeTerminalIdleEmptyReclaimMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TERMINAL_IDLE_EMPTY_RECLAIM_MS
    )
    expect(normalizeTerminalIdleEmptyReclaimMs('one hour')).toBe(
      DEFAULT_TERMINAL_IDLE_EMPTY_RECLAIM_MS
    )
  })

  it('exempts legacy, manual, and ever-used terminals', () => {
    expect(isTerminalIdleEmptyReclaimEligible({})).toBe(false)
    expect(isTerminalIdleEmptyReclaimEligible({ creationOrigin: 'user' })).toBe(false)
    expect(
      isTerminalIdleEmptyReclaimEligible({
        creationOrigin: 'cli',
        hasEverReceivedExternalInput: true
      })
    ).toBe(false)
    expect(isTerminalIdleEmptyReclaimEligible({ creationOrigin: 'orchestration' })).toBe(true)
  })
})
