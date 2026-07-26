import { describe, expect, it } from 'vitest'
import {
  evaluateIdleReclaimCandidate,
  type IdleEmptyTerminalReclaimCandidate,
  type IdleEmptyTerminalReclaimCloseMode,
  type IdleEmptyTerminalReclaimConfig,
  type IdleEmptyTerminalReclaimRefusalReason
} from './idle-empty-terminal-reclaim'

const NOW = 10_000_000
const IDLE_THRESHOLD_MS = 60 * 60 * 1000
const CONFIG: IdleEmptyTerminalReclaimConfig = {
  enabled: true,
  idleThresholdMs: IDLE_THRESHOLD_MS
}

function candidate(
  overrides: Partial<IdleEmptyTerminalReclaimCandidate> = {}
): IdleEmptyTerminalReclaimCandidate {
  return {
    tabId: 'tab-1',
    leafId: 'leaf-1',
    ptyId: 'pty-1',
    worktreeId: 'worktree-1',
    incarnationId: 'incarnation-1',
    expectedIncarnationId: 'incarnation-1',
    activityGeneration: 4,
    expectedActivityGeneration: 4,
    isSinglePane: true,
    hasExactTabLeafPtyWorktreeBinding: true,
    hasSharedPty: false,
    isPersisted: true,
    rendererOwnsPersistedTab: true,
    origin: 'cli',
    used: false,
    isPinned: false,
    isSleepingOrHibernating: false,
    hasPendingRestoreOrReconnect: false,
    hasStartupCommand: false,
    hasLaunchConfig: false,
    hasResumeProviderSession: false,
    hasLaunchAgent: false,
    hasForegroundAgent: false,
    agentStatus: 'none',
    hasProviderSession: false,
    hasOrchestrationOwnership: false,
    lastActivityAt: NOW - IDLE_THRESHOLD_MS,
    providerConnected: true,
    providerWritable: true,
    inspection: {
      status: 'success',
      foregroundProcess: 'shell',
      hasChildProcesses: false
    },
    rendererVisibility: 'hidden',
    hasMobileDriver: false,
    hasMobileSubscriber: false,
    hasRemoteDesktopViewer: false,
    isActiveCoordinatorHandle: false,
    hasPendingOrDispatchedContext: false,
    hasInFlightTransaction: false,
    hasSecondConfirmation: true,
    hasExactIdentityClaim: true,
    ...overrides
  }
}

type GuardCase = {
  guard: number
  reason: IdleEmptyTerminalReclaimRefusalReason
  candidateOverrides?: Partial<IdleEmptyTerminalReclaimCandidate>
  configOverrides?: Partial<IdleEmptyTerminalReclaimConfig>
}

const GUARD_CASES: GuardCase[] = [
  { guard: 1, reason: 'feature-disabled', configOverrides: { enabled: false } },
  { guard: 2, reason: 'origin-not-eligible', candidateOverrides: { origin: 'user' } },
  {
    guard: 3,
    reason: 'topology-or-binding-invalid',
    candidateOverrides: { hasExactTabLeafPtyWorktreeBinding: false }
  },
  { guard: 4, reason: 'protected-terminal-state', candidateOverrides: { isPinned: true } },
  { guard: 5, reason: 'terminal-used-or-has-launch-work', candidateOverrides: { used: true } },
  {
    guard: 6,
    reason: 'agent-or-orchestration-owned',
    candidateOverrides: { hasForegroundAgent: true }
  },
  {
    guard: 7,
    reason: 'not-idle-or-activity-stale',
    candidateOverrides: { expectedActivityGeneration: 5 }
  },
  {
    guard: 8,
    reason: 'provider-unavailable-or-incarnation-stale',
    candidateOverrides: { expectedIncarnationId: 'incarnation-2' }
  },
  {
    guard: 9,
    reason: 'foreground-process-not-empty-shell',
    candidateOverrides: {
      inspection: { status: 'success', foregroundProcess: 'wrapper', hasChildProcesses: false }
    }
  },
  { guard: 10, reason: 'renderer-visible', candidateOverrides: { rendererVisibility: 'visible' } },
  {
    guard: 11,
    reason: 'mobile-or-remote-viewer-attached',
    candidateOverrides: { hasMobileDriver: true }
  },
  {
    guard: 12,
    reason: 'active-coordinator-or-dispatch',
    candidateOverrides: { isActiveCoordinatorHandle: true }
  },
  {
    guard: 13,
    reason: 'terminal-transaction-in-flight',
    candidateOverrides: { hasInFlightTransaction: true }
  },
  {
    guard: 14,
    reason: 'final-confirmation-or-claim-missing',
    candidateOverrides: { hasSecondConfirmation: false }
  }
]

const FAIL_CLOSED_CASES: {
  name: string
  overrides: Partial<IdleEmptyTerminalReclaimCandidate>
  reason: IdleEmptyTerminalReclaimRefusalReason
}[] = [
  {
    name: 'missing origin',
    overrides: { origin: undefined },
    reason: 'origin-not-eligible'
  },
  {
    name: 'legacy origin',
    overrides: { origin: 'legacy' },
    reason: 'origin-not-eligible'
  },
  {
    name: 'unknown used fact',
    overrides: { used: undefined },
    reason: 'terminal-used-or-has-launch-work'
  },
  {
    name: 'inspection error',
    overrides: {
      inspection: { status: 'error', foregroundProcess: null, hasChildProcesses: null }
    },
    reason: 'foreground-process-not-empty-shell'
  },
  {
    name: 'missing inspection',
    overrides: { inspection: null },
    reason: 'foreground-process-not-empty-shell'
  },
  {
    name: 'shell child process',
    overrides: {
      inspection: { status: 'success', foregroundProcess: 'shell', hasChildProcesses: true }
    },
    reason: 'foreground-process-not-empty-shell'
  }
]

describe('evaluateIdleReclaimCandidate', () => {
  it.each(GUARD_CASES)('refuses guard $guard with $reason', (guardCase) => {
    expect(
      evaluateIdleReclaimCandidate(
        candidate(guardCase.candidateOverrides),
        { ...CONFIG, ...guardCase.configOverrides },
        NOW
      )
    ).toMatchObject({ eligible: false, reason: guardCase.reason })
  })

  it.each(GUARD_CASES)('allows a candidate when guard $guard is satisfied', () => {
    expect(evaluateIdleReclaimCandidate(candidate(), CONFIG, NOW)).toEqual({
      eligible: true,
      closeMode: 'renderer-owned-persisted'
    })
  })

  it('allows a candidate only after all 14 guards pass', () => {
    expect(evaluateIdleReclaimCandidate(candidate(), CONFIG, NOW)).toEqual({
      eligible: true,
      closeMode: 'renderer-owned-persisted'
    })
  })

  it.each<{
    mode: IdleEmptyTerminalReclaimCloseMode
    overrides: Partial<IdleEmptyTerminalReclaimCandidate>
  }>([
    { mode: 'renderer-owned-persisted', overrides: {} },
    {
      mode: 'runtime-owned-persisted',
      overrides: { isPersisted: true, rendererOwnsPersistedTab: false }
    },
    { mode: 'hot-only', overrides: { isPersisted: false, rendererOwnsPersistedTab: null } }
  ])('classifies $mode candidates', ({ mode, overrides }) => {
    expect(evaluateIdleReclaimCandidate(candidate(overrides), CONFIG, NOW)).toEqual({
      eligible: true,
      closeMode: mode
    })
  })

  it.each(FAIL_CLOSED_CASES)('fails closed for $name', ({ overrides, reason }) => {
    expect(evaluateIdleReclaimCandidate(candidate(overrides), CONFIG, NOW)).toMatchObject({
      eligible: false,
      reason
    })
  })

  it('refuses a stale activity generation even when the terminal is old enough', () => {
    expect(
      evaluateIdleReclaimCandidate(candidate({ expectedActivityGeneration: 5 }), CONFIG, NOW)
    ).toMatchObject({ eligible: false, reason: 'not-idle-or-activity-stale' })
  })

  it('refuses a stale incarnation even when all process facts remain safe', () => {
    expect(
      evaluateIdleReclaimCandidate(
        candidate({ expectedIncarnationId: 'new-incarnation' }),
        CONFIG,
        NOW
      )
    ).toMatchObject({ eligible: false, reason: 'provider-unavailable-or-incarnation-stale' })
  })

  it('normalizes the reclaim threshold before checking idle time', () => {
    const normalizedMinimum = 5 * 60 * 1000
    expect(
      evaluateIdleReclaimCandidate(
        candidate({ lastActivityAt: NOW - normalizedMinimum }),
        { enabled: true, idleThresholdMs: 0 },
        NOW
      )
    ).toMatchObject({ eligible: true })
  })
})
