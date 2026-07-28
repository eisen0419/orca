import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  evaluateIdleReclaimCandidate,
  type IdleEmptyTerminalReclaimCandidate
} from './idle-empty-terminal-reclaim'
import { fullyEligibleHotCandidate } from './idle-empty-terminal-reclaim-hot-only-fixture'
import {
  HOT_LEAF_ID,
  HOT_PANE_KEY,
  HOT_TAB_ID,
  SECOND_LEAF_ID,
  SECOND_PTY_ID,
  SECOND_TAB_ID,
  WORKTREE_ID,
  syncReclaimGraph
} from './idle-empty-terminal-reclaim-lifecycle-fixture'
import { createPaneRecoveryTransactionCarrierHarness } from './idle-empty-terminal-reclaim-transaction-carrier-fixture'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('idle empty-terminal reclaim pane recovery admission', () => {
  it('holds only the exact recovering pane established by recoverTerminalPane', async () => {
    const carrier = await createPaneRecoveryTransactionCarrierHarness()
    const pendingPtyId = 'pty-pending-pane-recovery'
    try {
      const pendingPty = carrier.internals.recordPtyWorktree(pendingPtyId, WORKTREE_ID, {
        connected: true,
        incarnationId: 'pending-pane-recovery-incarnation',
        tabId: HOT_TAB_ID,
        paneKey: HOT_PANE_KEY
      })
      pendingPty.creationOrigin = 'cli'
      pendingPty.lastActivityAt = 0
      carrier.internals.launchFactsAuthoritativeIncarnationByPtyId.set(
        pendingPtyId,
        'pending-pane-recovery-incarnation'
      )
      carrier.runtime.setOrchestrationDb({
        getActiveCoordinatorRun: () => undefined,
        getActiveDispatchAssignees: () => []
      } as never)
      syncReclaimGraph(carrier.runtime, {
        tabs: [],
        leaves: [],
        mobile: [
          { tabId: HOT_TAB_ID, leafId: HOT_LEAF_ID, ptyId: pendingPtyId },
          { tabId: SECOND_TAB_ID, leafId: SECOND_LEAF_ID, ptyId: SECOND_PTY_ID }
        ]
      })

      expect([...carrier.internals.ptysById.keys()]).toContain(pendingPtyId)

      const candidatesByPtyId = new Map<string, IdleEmptyTerminalReclaimCandidate>()
      for (let index = 0; index < 3; index += 1) {
        for (const candidate of await carrier.internals.collectIdleEmptyTerminalReclaimCandidates()) {
          if (candidate.ptyId) {
            candidatesByPtyId.set(candidate.ptyId, candidate)
          }
        }
      }
      const exactPaneCandidate = candidatesByPtyId.get(pendingPtyId)
      const differentPaneCandidate = candidatesByPtyId.get(SECOND_PTY_ID)

      expect(exactPaneCandidate?.hasInFlightTransaction).toBe(true)
      expect(
        evaluateIdleReclaimCandidate(
          exactPaneCandidate ?? fullyEligibleHotCandidate(),
          { enabled: true },
          1e9
        )
      ).toEqual({ eligible: false, reason: 'terminal-transaction-in-flight' })
      expect(differentPaneCandidate?.hasInFlightTransaction).toBe(false)
    } finally {
      await carrier.releaseCarrier()
      carrier.runtime.dispose()
    }
  })
})
