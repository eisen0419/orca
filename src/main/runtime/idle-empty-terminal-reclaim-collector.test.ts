import { describe, expect, it, vi } from 'vitest'
import {
  collectIdleEmptyTerminalReclaimCandidates,
  type IdleEmptyTerminalReclaimCandidateSnapshot
} from './idle-empty-terminal-reclaim-collector'
import { evaluateIdleReclaimCandidate } from './idle-empty-terminal-reclaim'

function candidateSnapshot(
  overrides: Partial<IdleEmptyTerminalReclaimCandidateSnapshot> = {}
): IdleEmptyTerminalReclaimCandidateSnapshot {
  return {
    tabId: 'tab-1',
    leafId: 'leaf-1',
    ptyId: 'pty-1',
    worktreeId: 'worktree-1',
    incarnationId: 'incarnation-1',
    expectedIncarnationId: 'incarnation-1',
    activityGeneration: 1,
    expectedActivityGeneration: 1,
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
    lastActivityAt: 0,
    providerConnected: true,
    providerWritable: true,
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

const successfulInspection = {
  status: 'success' as const,
  foregroundProcess: 'shell' as const,
  hasChildProcesses: false
}

describe('collectIdleEmptyTerminalReclaimCandidates', () => {
  it.each([
    {
      shape: 'renderer-owned persisted',
      snapshot: candidateSnapshot({ isPersisted: true, rendererOwnsPersistedTab: true })
    },
    {
      shape: 'runtime-owned persisted',
      snapshot: candidateSnapshot({
        isPersisted: true,
        rendererOwnsPersistedTab: false,
        authoritativePersistedOwner: { kind: 'runtime', source: 'serve-or-ssh-pty-id' }
      })
    },
    {
      shape: 'hot-only',
      snapshot: candidateSnapshot({
        isPersisted: false,
        rendererOwnsPersistedTab: false,
        authoritativePersistedOwner: null
      })
    }
  ])('collects the $shape tab shape without changing ownership facts', async ({ snapshot }) => {
    const candidates = await collectIdleEmptyTerminalReclaimCandidates(
      [snapshot],
      async () => successfulInspection
    )

    expect(candidates).toEqual([{ ...snapshot, inspection: successfulInspection }])
  })

  it('collects a hot-only PTY with no session row as hot-only', async () => {
    const [candidate] = await collectIdleEmptyTerminalReclaimCandidates(
      [
        candidateSnapshot({
          isPersisted: false,
          rendererOwnsPersistedTab: false,
          authoritativePersistedOwner: null
        })
      ],
      async () => successfulInspection
    )

    expect(candidate).toMatchObject({
      isPersisted: false,
      rendererOwnsPersistedTab: false,
      inspection: successfulInspection
    })
  })

  it('preserves contradictory and unknown ownership as refusing null facts', async () => {
    const candidates = await collectIdleEmptyTerminalReclaimCandidates(
      [
        candidateSnapshot({
          isPersisted: false,
          rendererOwnsPersistedTab: true,
          authoritativePersistedOwner: null
        }),
        candidateSnapshot({
          ptyId: 'pty-2',
          isPersisted: null,
          rendererOwnsPersistedTab: null,
          authoritativePersistedOwner: null,
          isPinned: null,
          rendererVisibility: null
        })
      ],
      async () => successfulInspection
    )

    expect(candidates[0]).toMatchObject({ isPersisted: false, rendererOwnsPersistedTab: true })
    expect(evaluateIdleReclaimCandidate(candidates[0]!, { enabled: true }, 60 * 60 * 1000)).toEqual(
      {
        eligible: false,
        reason: 'topology-or-binding-invalid'
      }
    )
    expect(candidates[1]).toMatchObject({
      isPersisted: null,
      rendererOwnsPersistedTab: null,
      isPinned: null,
      rendererVisibility: null
    })
  })

  it('caps provider inspection at two concurrent candidates', async () => {
    let inFlight = 0
    let peak = 0
    const inspect = vi.fn(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return successfulInspection
    })

    await collectIdleEmptyTerminalReclaimCandidates(
      [0, 1, 2, 3, 4].map((index) => candidateSnapshot({ ptyId: `pty-${index}` })),
      inspect
    )

    expect(peak).toBe(2)
  })

  it('turns an inspection rejection into a refusing candidate without throwing', async () => {
    const [candidate] = await collectIdleEmptyTerminalReclaimCandidates(
      [candidateSnapshot()],
      async () => {
        throw new Error('inspection unavailable')
      }
    )

    expect(candidate?.inspection).toEqual({
      status: 'error',
      foregroundProcess: null,
      hasChildProcesses: null
    })
    expect(evaluateIdleReclaimCandidate(candidate!, { enabled: true }, 60 * 60 * 1000)).toEqual({
      eligible: false,
      reason: 'foreground-process-not-empty-shell'
    })
  })
})
