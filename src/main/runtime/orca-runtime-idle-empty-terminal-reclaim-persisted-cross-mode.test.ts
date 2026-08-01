import { describe, expect, it } from 'vitest'
import type {
  PersistedMatrixHarness,
  PersistedMatrixMode
} from './idle-empty-terminal-reclaim-persisted-matrix-fixture'
import { createPersistedMatrixRuntime } from './idle-empty-terminal-reclaim-persisted-matrix-runtime'

type CrossModeRow = {
  firstMode: PersistedMatrixMode
  latch: 'null' | 'flush-failure' | 'flush-shaped'
  followupModes: readonly PersistedMatrixMode[]
}

const rows: readonly CrossModeRow[] = [
  {
    firstMode: 'hot-only',
    latch: 'null',
    followupModes: ['renderer-owned-persisted', 'runtime-owned-persisted']
  },
  {
    firstMode: 'hot-only',
    latch: 'flush-shaped',
    followupModes: ['renderer-owned-persisted', 'runtime-owned-persisted']
  },
  {
    firstMode: 'renderer-owned-persisted',
    latch: 'null',
    followupModes: ['hot-only', 'runtime-owned-persisted']
  },
  {
    firstMode: 'renderer-owned-persisted',
    latch: 'flush-failure',
    followupModes: ['hot-only', 'runtime-owned-persisted']
  },
  {
    firstMode: 'runtime-owned-persisted',
    latch: 'null',
    followupModes: ['hot-only', 'renderer-owned-persisted']
  },
  {
    firstMode: 'runtime-owned-persisted',
    latch: 'flush-failure',
    followupModes: ['hot-only', 'renderer-owned-persisted']
  }
]

const tabIds = [
  '77777777-7777-4777-8777-777777777777',
  '99999999-9999-4999-8999-999999999999',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
] as const
const leafIds = [
  '88888888-8888-4888-8888-888888888888',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
] as const

function ptyIdFor(mode: PersistedMatrixMode, label: string): string {
  return mode === 'runtime-owned-persisted' ? `serve-${label}` : `${label}-${mode}`
}

async function reclaim(
  harness: PersistedMatrixHarness,
  mode: PersistedMatrixMode,
  candidate: PersistedMatrixHarness['candidate']
) {
  const config = { enabled: true, idleThresholdMs: 5 * 60 * 1000 }
  return mode === 'hot-only'
    ? harness.internals.reclaimHotOnlyIdleTerminal(candidate, config)
    : harness.internals.reclaimPersistedIdleTerminal(candidate, config)
}

function clearLatchedResidue(harness: PersistedMatrixHarness): void {
  const slot = harness.internals.idleTerminalReclaimReservationOrLatch as {
    kind: 'ambiguity-latch'
    latch: { ptyId: string; tabId: string; leafId: string; worktreeId: string }
  }
  const { ptyId, tabId, leafId, worktreeId } = slot.latch
  const session = harness.getSession()
  session.tabsByWorktree[worktreeId] = (session.tabsByWorktree[worktreeId] ?? []).filter(
    (tab) => tab.id !== tabId
  )
  delete session.terminalLayoutsByTabId[tabId]
  delete session.remoteSessionIdsByTabId?.[tabId]
  delete session.terminalPtyIncarnationsByPaneKey?.[`${tabId}:${leafId}`]
  harness.internals.mobileSessionTabsByWorktree.clear()
  harness.internals.tabs.clear()
  harness.internals.leaves.clear()
  harness.internals.leavesByPtyId.clear()
  harness.internals.handleByPtyId.clear()
  harness.internals.handleByLeafKey.clear()
  harness.internals.handles.clear()
  harness.internals.waitersByHandle.clear()
  harness.internals.detachedPreAllocatedLeaves.clear()
  harness.internals.headlessTerminals.clear()
  harness.internals.headlessHydrationState.clear()
  harness.internals.ptysById.delete(ptyId)
  harness.internals.reclaimInFlightByPtyId.clear()
  harness.internals.headlessTerminalArchiveByOperationId.clear()
  harness.internals.terminalSleepByWorktreeId.clear()
  harness.internals.terminalMutationTailByWorktreeId.clear()
  harness.internals.terminalSleepStateByWorktreeId.clear()
  harness.internals.terminalPaneRecoveryByIdentity.clear()
  harness.internals.controllerTerminalIdentityByPtyId.clear()
  harness.internals.graphStatus = 'ready'
  harness.setProviderState(false)
  harness.internals.releaseIdleTerminalReclaimAmbiguityLatchWhenNaturallyCleared()
  expect(harness.internals.idleTerminalReclaimReservationOrLatch).toBeNull()
  harness.setProviderState(undefined)
  harness.refreshGraph()
}

describe('persisted reclaim cross-mode capacity', () => {
  it.each(rows)(
    '$firstMode $latch latch blocks both other modes and then clears',
    async ({ firstMode, latch, followupModes }) => {
      const behavior =
        latch === 'flush-failure'
          ? { flushFailure: true }
          : latch === 'flush-shaped'
            ? { postStop: 'present-null' as const, flushFailure: true }
            : { postStop: 'present-null' as const }
      const harness = createPersistedMatrixRuntime({ mode: firstMode, behavior })
      await expect(reclaim(harness, firstMode, harness.candidate)).resolves.toMatchObject({
        reclaimed: false
      })
      expect(harness.stopAndWait).toHaveBeenCalledOnce()
      expect(harness.internals.idleTerminalReclaimReservationOrLatch).toMatchObject({
        kind: 'ambiguity-latch'
      })
      if (latch === 'flush-shaped') {
        expect(harness.store.flushOrThrow).not.toHaveBeenCalled()
      }

      const followups = followupModes.map((mode, index) =>
        harness.addCandidate({
          mode,
          ptyId: ptyIdFor(mode, `cross-${index + 2}`),
          tabId: tabIds[index]!,
          leafId: leafIds[index]!,
          incarnationId: `cross-${index + 2}-incarnation`
        })
      )
      for (const [index, candidate] of followups.entries()) {
        await reclaim(harness, followupModes[index]!, candidate)
        expect(harness.stopAndWait).toHaveBeenCalledOnce()
      }

      if (latch === 'flush-failure') {
        harness.setBehavior({ flushFailure: false })
      }
      clearLatchedResidue(harness)
      const third = harness.addCandidate({
        mode: followupModes[1]!,
        ptyId: ptyIdFor(followupModes[1]!, 'cross-third'),
        tabId: tabIds[2]!,
        leafId: leafIds[2]!,
        incarnationId: 'cross-third-incarnation'
      })
      await reclaim(harness, followupModes[1]!, third)
      expect(harness.stopAndWait).toHaveBeenCalledTimes(2)
      expect(harness.stopAndWait).toHaveBeenLastCalledWith(
        ptyIdFor(followupModes[1]!, 'cross-third')
      )
      harness.dispose()
    }
  )
})
