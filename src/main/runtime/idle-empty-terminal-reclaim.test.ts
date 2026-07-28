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
    authoritativePersistedOwner: { kind: 'renderer', source: 'ready-exact-renderer-binding' },
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

type EvaluationInput = {
  candidateOverrides?: Partial<IdleEmptyTerminalReclaimCandidate>
  configOverrides?: Partial<IdleEmptyTerminalReclaimConfig>
  now?: number
}

function evaluate(input: EvaluationInput = {}) {
  return evaluateIdleReclaimCandidate(
    candidate(input.candidateOverrides),
    { ...CONFIG, ...input.configOverrides },
    input.now ?? NOW
  )
}

type GuardPredicateCase = {
  guard: number
  predicate: string
  reason: IdleEmptyTerminalReclaimRefusalReason
  unsafe: EvaluationInput
  unknown: EvaluationInput
  safe?: EvaluationInput
}

const GUARD_PREDICATE_CASES: GuardPredicateCase[] = [
  {
    guard: 1,
    predicate: 'feature enabled',
    reason: 'feature-disabled',
    unsafe: { configOverrides: { enabled: false } },
    unknown: { configOverrides: { enabled: undefined } }
  },
  {
    guard: 2,
    predicate: 'eligible origin',
    reason: 'origin-not-eligible',
    unsafe: { candidateOverrides: { origin: 'user' } },
    unknown: { candidateOverrides: { origin: undefined } },
    safe: { candidateOverrides: { origin: 'orchestration' } }
  },
  {
    guard: 3,
    predicate: 'tab id',
    reason: 'topology-or-binding-invalid',
    unsafe: { candidateOverrides: { tabId: '' } },
    unknown: { candidateOverrides: { tabId: null } },
    safe: { candidateOverrides: { tabId: 'tab-2' } }
  },
  {
    guard: 3,
    predicate: 'leaf id',
    reason: 'topology-or-binding-invalid',
    unsafe: { candidateOverrides: { leafId: '' } },
    unknown: { candidateOverrides: { leafId: null } },
    safe: { candidateOverrides: { leafId: 'leaf-2' } }
  },
  {
    guard: 3,
    predicate: 'pty id',
    reason: 'topology-or-binding-invalid',
    unsafe: { candidateOverrides: { ptyId: '' } },
    unknown: { candidateOverrides: { ptyId: null } },
    safe: { candidateOverrides: { ptyId: 'pty-2' } }
  },
  {
    guard: 3,
    predicate: 'worktree id',
    reason: 'topology-or-binding-invalid',
    unsafe: { candidateOverrides: { worktreeId: '' } },
    unknown: { candidateOverrides: { worktreeId: null } },
    safe: { candidateOverrides: { worktreeId: 'worktree-2' } }
  },
  {
    guard: 3,
    predicate: 'single pane topology',
    reason: 'topology-or-binding-invalid',
    unsafe: { candidateOverrides: { isSinglePane: false } },
    unknown: { candidateOverrides: { isSinglePane: null } }
  },
  {
    guard: 3,
    predicate: 'exact tab leaf pty worktree binding',
    reason: 'topology-or-binding-invalid',
    unsafe: { candidateOverrides: { hasExactTabLeafPtyWorktreeBinding: false } },
    unknown: { candidateOverrides: { hasExactTabLeafPtyWorktreeBinding: null } }
  },
  {
    guard: 3,
    predicate: 'unshared pty',
    reason: 'topology-or-binding-invalid',
    unsafe: { candidateOverrides: { hasSharedPty: true } },
    unknown: { candidateOverrides: { hasSharedPty: null } }
  },
  {
    guard: 3,
    predicate: 'consistent close ownership',
    reason: 'topology-or-binding-invalid',
    unsafe: {
      candidateOverrides: { isPersisted: false, rendererOwnsPersistedTab: true }
    },
    unknown: { candidateOverrides: { isPersisted: null } }
  },
  {
    guard: 4,
    predicate: 'unpinned tab',
    reason: 'protected-terminal-state',
    unsafe: { candidateOverrides: { isPinned: true } },
    unknown: { candidateOverrides: { isPinned: null } }
  },
  {
    guard: 4,
    predicate: 'non sleeping terminal',
    reason: 'protected-terminal-state',
    unsafe: { candidateOverrides: { isSleepingOrHibernating: true } },
    unknown: { candidateOverrides: { isSleepingOrHibernating: null } }
  },
  {
    guard: 4,
    predicate: 'no pending restore or reconnect',
    reason: 'protected-terminal-state',
    unsafe: { candidateOverrides: { hasPendingRestoreOrReconnect: true } },
    unknown: { candidateOverrides: { hasPendingRestoreOrReconnect: null } }
  },
  {
    guard: 5,
    predicate: 'never used terminal',
    reason: 'terminal-used-or-has-launch-work',
    unsafe: { candidateOverrides: { used: true } },
    unknown: { candidateOverrides: { used: undefined } }
  },
  {
    guard: 5,
    predicate: 'no startup command',
    reason: 'terminal-used-or-has-launch-work',
    unsafe: { candidateOverrides: { hasStartupCommand: true } },
    unknown: { candidateOverrides: { hasStartupCommand: null } }
  },
  {
    guard: 5,
    predicate: 'no launch config',
    reason: 'terminal-used-or-has-launch-work',
    unsafe: { candidateOverrides: { hasLaunchConfig: true } },
    unknown: { candidateOverrides: { hasLaunchConfig: null } }
  },
  {
    guard: 5,
    predicate: 'no resume provider session',
    reason: 'terminal-used-or-has-launch-work',
    unsafe: { candidateOverrides: { hasResumeProviderSession: true } },
    unknown: { candidateOverrides: { hasResumeProviderSession: null } }
  },
  {
    guard: 5,
    predicate: 'no launch agent',
    reason: 'terminal-used-or-has-launch-work',
    unsafe: { candidateOverrides: { hasLaunchAgent: true } },
    unknown: { candidateOverrides: { hasLaunchAgent: null } }
  },
  {
    guard: 6,
    predicate: 'no foreground agent',
    reason: 'agent-or-orchestration-owned',
    unsafe: { candidateOverrides: { hasForegroundAgent: true } },
    unknown: { candidateOverrides: { hasForegroundAgent: null } }
  },
  {
    guard: 6,
    predicate: 'no agent status',
    reason: 'agent-or-orchestration-owned',
    unsafe: { candidateOverrides: { agentStatus: 'working' } },
    unknown: { candidateOverrides: { agentStatus: null } }
  },
  {
    guard: 6,
    predicate: 'no provider session',
    reason: 'agent-or-orchestration-owned',
    unsafe: { candidateOverrides: { hasProviderSession: true } },
    unknown: { candidateOverrides: { hasProviderSession: null } }
  },
  {
    guard: 6,
    predicate: 'no orchestration ownership',
    reason: 'agent-or-orchestration-owned',
    unsafe: { candidateOverrides: { hasOrchestrationOwnership: true } },
    unknown: { candidateOverrides: { hasOrchestrationOwnership: null } }
  },
  {
    guard: 7,
    predicate: 'finite current time',
    reason: 'not-idle-or-activity-stale',
    unsafe: { now: Number.NEGATIVE_INFINITY },
    unknown: { now: Number.NaN }
  },
  {
    guard: 7,
    predicate: 'idle duration',
    reason: 'not-idle-or-activity-stale',
    unsafe: { candidateOverrides: { lastActivityAt: NOW } },
    unknown: { candidateOverrides: { lastActivityAt: null } }
  },
  {
    guard: 7,
    predicate: 'finite last activity time',
    reason: 'not-idle-or-activity-stale',
    unsafe: { candidateOverrides: { lastActivityAt: Number.NaN } },
    unknown: { candidateOverrides: { lastActivityAt: null } }
  },
  {
    guard: 7,
    predicate: 'integer activity generation',
    reason: 'not-idle-or-activity-stale',
    unsafe: {
      candidateOverrides: { activityGeneration: 4.5, expectedActivityGeneration: 4.5 }
    },
    unknown: { candidateOverrides: { activityGeneration: null } }
  },
  {
    guard: 7,
    predicate: 'exact activity generation',
    reason: 'not-idle-or-activity-stale',
    unsafe: { candidateOverrides: { expectedActivityGeneration: 5 } },
    unknown: { candidateOverrides: { expectedActivityGeneration: null } }
  },
  {
    guard: 8,
    predicate: 'connected provider',
    reason: 'provider-unavailable-or-incarnation-stale',
    unsafe: { candidateOverrides: { providerConnected: false } },
    unknown: { candidateOverrides: { providerConnected: null } }
  },
  {
    guard: 8,
    predicate: 'writable provider',
    reason: 'provider-unavailable-or-incarnation-stale',
    unsafe: { candidateOverrides: { providerWritable: false } },
    unknown: { candidateOverrides: { providerWritable: null } }
  },
  {
    guard: 8,
    predicate: 'nonempty incarnation id',
    reason: 'provider-unavailable-or-incarnation-stale',
    unsafe: { candidateOverrides: { incarnationId: '', expectedIncarnationId: '' } },
    unknown: { candidateOverrides: { incarnationId: null, expectedIncarnationId: null } }
  },
  {
    guard: 8,
    predicate: 'exact incarnation id',
    reason: 'provider-unavailable-or-incarnation-stale',
    unsafe: { candidateOverrides: { expectedIncarnationId: 'incarnation-2' } },
    unknown: { candidateOverrides: { expectedIncarnationId: null } }
  },
  {
    guard: 9,
    predicate: 'inspection result',
    reason: 'foreground-process-not-empty-shell',
    unsafe: {
      candidateOverrides: {
        inspection: { status: 'error', foregroundProcess: 'shell', hasChildProcesses: false }
      }
    },
    unknown: { candidateOverrides: { inspection: null } }
  },
  {
    guard: 9,
    predicate: 'successful inspection',
    reason: 'foreground-process-not-empty-shell',
    unsafe: {
      candidateOverrides: {
        inspection: { status: 'error', foregroundProcess: 'shell', hasChildProcesses: false }
      }
    },
    unknown: {
      candidateOverrides: {
        inspection: { status: null, foregroundProcess: 'shell', hasChildProcesses: false }
      }
    }
  },
  {
    guard: 9,
    predicate: 'shell foreground process',
    reason: 'foreground-process-not-empty-shell',
    unsafe: {
      candidateOverrides: {
        inspection: { status: 'success', foregroundProcess: 'wrapper', hasChildProcesses: false }
      }
    },
    unknown: {
      candidateOverrides: {
        inspection: { status: 'success', foregroundProcess: null, hasChildProcesses: false }
      }
    }
  },
  {
    guard: 9,
    predicate: 'no shell child processes',
    reason: 'foreground-process-not-empty-shell',
    unsafe: {
      candidateOverrides: {
        inspection: { status: 'success', foregroundProcess: 'shell', hasChildProcesses: true }
      }
    },
    unknown: {
      candidateOverrides: {
        inspection: { status: 'success', foregroundProcess: 'shell', hasChildProcesses: null }
      }
    }
  },
  {
    guard: 10,
    predicate: 'hidden renderer tab',
    reason: 'renderer-visible',
    unsafe: { candidateOverrides: { rendererVisibility: 'visible' } },
    unknown: { candidateOverrides: { rendererVisibility: null } }
  },
  {
    guard: 11,
    predicate: 'no mobile driver',
    reason: 'mobile-or-remote-viewer-attached',
    unsafe: { candidateOverrides: { hasMobileDriver: true } },
    unknown: { candidateOverrides: { hasMobileDriver: null } }
  },
  {
    guard: 11,
    predicate: 'no mobile subscriber',
    reason: 'mobile-or-remote-viewer-attached',
    unsafe: { candidateOverrides: { hasMobileSubscriber: true } },
    unknown: { candidateOverrides: { hasMobileSubscriber: null } }
  },
  {
    guard: 11,
    predicate: 'no remote desktop viewer',
    reason: 'mobile-or-remote-viewer-attached',
    unsafe: { candidateOverrides: { hasRemoteDesktopViewer: true } },
    unknown: { candidateOverrides: { hasRemoteDesktopViewer: null } }
  },
  {
    guard: 12,
    predicate: 'inactive coordinator handle',
    reason: 'active-coordinator-or-dispatch',
    unsafe: { candidateOverrides: { isActiveCoordinatorHandle: true } },
    unknown: { candidateOverrides: { isActiveCoordinatorHandle: null } }
  },
  {
    guard: 12,
    predicate: 'no pending or dispatched context',
    reason: 'active-coordinator-or-dispatch',
    unsafe: { candidateOverrides: { hasPendingOrDispatchedContext: true } },
    unknown: { candidateOverrides: { hasPendingOrDispatchedContext: null } }
  },
  {
    guard: 13,
    predicate: 'no in flight terminal transaction',
    reason: 'terminal-transaction-in-flight',
    unsafe: { candidateOverrides: { hasInFlightTransaction: true } },
    unknown: { candidateOverrides: { hasInFlightTransaction: null } }
  },
  {
    guard: 14,
    predicate: 'second confirmation',
    reason: 'final-confirmation-or-claim-missing',
    unsafe: { candidateOverrides: { hasSecondConfirmation: false } },
    unknown: { candidateOverrides: { hasSecondConfirmation: null } }
  },
  {
    guard: 14,
    predicate: 'exact identity claim',
    reason: 'final-confirmation-or-claim-missing',
    unsafe: { candidateOverrides: { hasExactIdentityClaim: false } },
    unknown: { candidateOverrides: { hasExactIdentityClaim: null } }
  }
]

describe('evaluateIdleReclaimCandidate', () => {
  it.each(GUARD_PREDICATE_CASES)(
    'refuses unsafe guard $guard predicate: $predicate',
    ({ reason, unsafe }) => {
      expect(evaluate(unsafe)).toEqual({ eligible: false, reason })
    }
  )

  it.each(GUARD_PREDICATE_CASES)(
    'refuses unknown guard $guard predicate: $predicate',
    ({ reason, unknown }) => {
      expect(evaluate(unknown)).toEqual({ eligible: false, reason })
    }
  )

  it.each(GUARD_PREDICATE_CASES)('allows safe guard $guard predicate: $predicate', ({ safe }) => {
    expect(evaluate(safe)).toEqual({
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
      overrides: {
        isPersisted: true,
        rendererOwnsPersistedTab: true,
        authoritativePersistedOwner: { kind: 'runtime', source: 'serve-or-ssh-pty-id' }
      }
    },
    {
      mode: 'hot-only',
      overrides: {
        isPersisted: false,
        rendererOwnsPersistedTab: false,
        authoritativePersistedOwner: null
      }
    }
  ])('classifies $mode candidates', ({ mode, overrides }) => {
    expect(evaluate({ candidateOverrides: overrides })).toEqual({ eligible: true, closeMode: mode })
  })

  it.each([
    {
      name: 'contradictory persistence and renderer ownership',
      overrides: { isPersisted: false, rendererOwnsPersistedTab: true }
    },
    { name: 'unknown persistence', overrides: { isPersisted: null } },
    {
      name: 'persisted terminal without a positive owner witness',
      overrides: { authoritativePersistedOwner: null }
    },
    {
      name: 'unknown renderer ownership for a hot-only tab',
      overrides: { isPersisted: false, rendererOwnsPersistedTab: null }
    }
  ])('refuses $name', ({ overrides }) => {
    expect(evaluate({ candidateOverrides: overrides })).toEqual({
      eligible: false,
      reason: 'topology-or-binding-invalid'
    })
  })

  it('keeps a positive persisted owner witness authoritative over the legacy projection fact', () => {
    expect(evaluate({ candidateOverrides: { rendererOwnsPersistedTab: null } })).toEqual({
      eligible: true,
      closeMode: 'renderer-owned-persisted'
    })
  })

  it('omits closeMode from refused evaluations', () => {
    const evaluation = evaluate({ candidateOverrides: { isPinned: true } })

    expect(evaluation).toEqual({ eligible: false, reason: 'protected-terminal-state' })
    expect('closeMode' in evaluation).toBe(false)
  })

  it('normalizes the reclaim threshold before checking idle time', () => {
    const normalizedMinimum = 5 * 60 * 1000
    expect(
      evaluate({
        candidateOverrides: { lastActivityAt: NOW - normalizedMinimum },
        configOverrides: { idleThresholdMs: 0 }
      })
    ).toMatchObject({ eligible: true })
  })
})
