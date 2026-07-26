/** Provenance and conservative facts consumed by the idle-shell reclaim feature. */
export type TerminalCreationOrigin = 'user' | 'cli' | 'orchestration'

export const DEFAULT_TERMINAL_IDLE_EMPTY_RECLAIM_MS = 60 * 60 * 1000
export const MIN_TERMINAL_IDLE_EMPTY_RECLAIM_MS = 5 * 60 * 1000
export const MAX_TERMINAL_IDLE_EMPTY_RECLAIM_MS = 7 * 24 * 60 * 60 * 1000

export function normalizeTerminalCreationOrigin(
  value: unknown
): TerminalCreationOrigin | undefined {
  return value === 'user' || value === 'cli' || value === 'orchestration' ? value : undefined
}

export function getTerminalCreationOrigin(value: unknown): TerminalCreationOrigin {
  return normalizeTerminalCreationOrigin(value) ?? 'user'
}

export function normalizeTerminalIdleEmptyReclaimMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TERMINAL_IDLE_EMPTY_RECLAIM_MS
  }
  return Math.min(
    MAX_TERMINAL_IDLE_EMPTY_RECLAIM_MS,
    Math.max(MIN_TERMINAL_IDLE_EMPTY_RECLAIM_MS, value)
  )
}

/** Missing provenance is legacy data, which must remain exempt rather than being guessed as CLI-created. */
export function isTerminalIdleEmptyReclaimEligible(input: {
  creationOrigin?: unknown
  hasEverReceivedExternalInput?: unknown
}): boolean {
  const origin = normalizeTerminalCreationOrigin(input.creationOrigin)
  return (
    (origin === 'cli' || origin === 'orchestration') && input.hasEverReceivedExternalInput !== true
  )
}
