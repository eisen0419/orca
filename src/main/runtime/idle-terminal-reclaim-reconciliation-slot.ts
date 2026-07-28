import type { IdleEmptyTerminalReclaimCloseMode } from './idle-empty-terminal-reclaim'

export type IdleTerminalReclaimAmbiguityLatch = {
  mode: IdleEmptyTerminalReclaimCloseMode
  claimIncarnationId: string
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
  ownerKind: 'renderer' | 'runtime' | 'hot-only'
  capturedTopologyRevision: number | null
  createdAt: number
  reason:
    | 'stop-threw'
    | 'stop-result-ambiguous'
    | 'provider-state-unknown'
    | 'post-stop-identity-null'
    | 'same-incarnation-unstable'
    | 'persistence-unavailable'
    | 'persistence-flush-failed'
}

export type IdleTerminalReclaimReservation = {
  kind: 'reservation'
}

export type IdleTerminalReclaimReconciliationSlot =
  | IdleTerminalReclaimReservation
  | { kind: 'ambiguity-latch'; latch: IdleTerminalReclaimAmbiguityLatch }

export type IdleTerminalReclaimCapturedPostStopIdentity = {
  ptyId: string
  worktreeId: string
  tabId: string
  leafId: string
  claimIncarnationId: string
  recordIdentity: object
}

export type IdleTerminalReclaimPostStopRecord = {
  recordIdentity: object
  ptyId: string
  worktreeId: string
  tabId: string | null
  leafId: string | null
  incarnationId: string | null
  connected: boolean
}

export type IdleTerminalReclaimPostStopOutcome =
  | 'release-no-stop'
  | 'release-replacement'
  | 'continue-exact-retirement'
  | 'retain-ambiguity'

export type IdleTerminalReclaimPostStopOutcomeInput = {
  stopResult: boolean | 'threw'
  providerHasPty: boolean | null
  captured: IdleTerminalReclaimCapturedPostStopIdentity
  current: IdleTerminalReclaimPostStopRecord | null
}

function hasDifferentNonNullIncarnation(input: IdleTerminalReclaimPostStopOutcomeInput): boolean {
  const { current } = input
  return (
    current !== null &&
    current.incarnationId !== null &&
    current.incarnationId !== input.captured.claimIncarnationId
  )
}

function hasExactCapturedTuple(input: IdleTerminalReclaimPostStopOutcomeInput): boolean {
  const { current, captured } = input
  return (
    current !== null &&
    current.recordIdentity === captured.recordIdentity &&
    current.ptyId === captured.ptyId &&
    current.worktreeId === captured.worktreeId &&
    current.tabId === captured.tabId &&
    current.leafId === captured.leafId &&
    current.incarnationId === captured.claimIncarnationId
  )
}

export function decideIdleTerminalReclaimPostStopOutcome(
  input: IdleTerminalReclaimPostStopOutcomeInput
): IdleTerminalReclaimPostStopOutcome {
  if (hasDifferentNonNullIncarnation(input)) {
    return 'release-replacement'
  }

  if (input.stopResult === 'threw') {
    return 'retain-ambiguity'
  }

  const exactCapturedTuple = hasExactCapturedTuple(input)
  if (input.stopResult === false) {
    return input.providerHasPty === true && exactCapturedTuple && input.current?.connected === true
      ? 'release-no-stop'
      : 'retain-ambiguity'
  }

  if (input.providerHasPty !== false) {
    return 'retain-ambiguity'
  }

  if (input.current === null || (exactCapturedTuple && input.current.connected === false)) {
    return 'continue-exact-retirement'
  }

  return 'retain-ambiguity'
}
