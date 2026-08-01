import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  PersistedMatrixHarness,
  PersistedMatrixMode
} from './idle-empty-terminal-reclaim-persisted-matrix-fixture'
import { createPersistedMatrixRuntime } from './idle-empty-terminal-reclaim-persisted-matrix-runtime'
import {
  HOT_PANE_KEY,
  HOT_TAB_ID,
  WORKTREE_ID
} from './idle-empty-terminal-reclaim-lifecycle-fixture'

const modes: readonly { name: string; mode: PersistedMatrixMode }[] = [
  { name: 'renderer-owned', mode: 'renderer-owned-persisted' },
  { name: 'runtime-owned', mode: 'runtime-owned-persisted' }
]

afterEach(() => {
  vi.restoreAllMocks()
})

async function reclaim(harness: PersistedMatrixHarness) {
  return reclaimCandidate(harness, harness.candidate)
}

async function reclaimCandidate(
  harness: PersistedMatrixHarness,
  candidate: PersistedMatrixHarness['candidate']
) {
  return harness.internals.reclaimPersistedIdleTerminal(candidate, {
    enabled: true,
    idleThresholdMs: 5 * 60 * 1000
  })
}

function latch(harness: PersistedMatrixHarness): void {
  expect(harness.internals.idleTerminalReclaimReservationOrLatch).toMatchObject({
    kind: 'ambiguity-latch'
  })
}

function clearPersistedTarget(harness: PersistedMatrixHarness): void {
  const session = harness.getSession()
  session.tabsByWorktree[WORKTREE_ID] = []
  delete session.terminalLayoutsByTabId[HOT_TAB_ID]
  delete session.remoteSessionIdsByTabId?.[HOT_TAB_ID]
  delete session.terminalPtyIncarnationsByPaneKey?.[HOT_PANE_KEY]
}

describe.each(modes)('persisted executor public decision matrix: $name', ({ mode }) => {
  it('occupied shared slot refuses before stop', async () => {
    const harness = createPersistedMatrixRuntime({ mode, behavior: { postStop: 'present-null' } })
    await reclaim(harness)
    expect(harness.stopAndWait).toHaveBeenCalledOnce()
    const second = harness.addCandidate({
      mode,
      ptyId: mode === 'runtime-owned-persisted' ? 'serve-occupied-slot' : 'occupied-slot-pty',
      tabId: '77777777-7777-4777-8777-777777777777',
      leafId: '88888888-8888-4888-8888-888888888888',
      incarnationId: 'occupied-slot-incarnation'
    })
    await reclaimCandidate(harness, second)
    expect(harness.stopAndWait).toHaveBeenCalledOnce()
    latch(harness)
    harness.dispose()
  })

  it.each([
    { name: 'provider false', mutate: (h: PersistedMatrixHarness) => h.setProviderState(false) },
    { name: 'provider null', mutate: (h: PersistedMatrixHarness) => h.setProviderState(null) },
    {
      name: 'claim changes during confirmation',
      mutate: (h: PersistedMatrixHarness) => {
        const original = h.internals.collectIdleEmptyTerminalReclaimConfirmation.bind(h.internals)
        vi.spyOn(h.internals, 'collectIdleEmptyTerminalReclaimConfirmation').mockImplementation(
          async (candidate) => {
            const confirmed = await original(candidate)
            const record = h.internals.ptysById.get(candidate.ptyId ?? '') as {
              incarnationId: string | null
            }
            record.incarnationId = 'changed-before-acquire'
            return confirmed
          }
        )
      }
    },
    {
      name: 'owner changes during confirmation',
      mutate: (h: PersistedMatrixHarness) => {
        const original = h.internals.collectIdleEmptyTerminalReclaimConfirmation.bind(h.internals)
        vi.spyOn(h.internals, 'collectIdleEmptyTerminalReclaimConfirmation').mockImplementation(
          async (candidate) => {
            const confirmed = await original(candidate)
            return confirmed ? { ...confirmed, authoritativePersistedOwner: null } : null
          }
        )
      }
    },
    {
      name: 'persistence binding changes during confirmation',
      mutate: (h: PersistedMatrixHarness) => {
        const original = h.internals.collectIdleEmptyTerminalReclaimConfirmation.bind(h.internals)
        vi.spyOn(h.internals, 'collectIdleEmptyTerminalReclaimConfirmation').mockImplementation(
          async (candidate) => {
            const confirmed = await original(candidate)
            clearPersistedTarget(h)
            return confirmed
          }
        )
      }
    },
    {
      name: 'activity changes during confirmation',
      mutate: (h: PersistedMatrixHarness) => {
        const original = h.internals.collectIdleEmptyTerminalReclaimConfirmation.bind(h.internals)
        vi.spyOn(h.internals, 'collectIdleEmptyTerminalReclaimConfirmation').mockImplementation(
          async (candidate) => {
            const confirmed = await original(candidate)
            const record = h.internals.ptysById.get(candidate.ptyId ?? '') as {
              activityGeneration: number
            }
            record.activityGeneration += 1
            return confirmed
          }
        )
      }
    }
  ])('$name refuses before stop', async ({ mutate }) => {
    const harness = createPersistedMatrixRuntime({ mode })
    mutate(harness)
    await reclaim(harness)
    expect(harness.stopAndWait).not.toHaveBeenCalled()
    expect(harness.store.flushOrThrow).not.toHaveBeenCalled()
    expect(harness.internals.idleTerminalReclaimReservationOrLatch).toBeNull()
    harness.dispose()
  })

  it.each([
    { name: 'stop throws', behavior: { throwOnStop: true } },
    {
      name: 'false with ambiguous absent record',
      behavior: { stopResult: false, postStop: 'absent' as const }
    },
    {
      name: 'false with ambiguous present-null record',
      behavior: { stopResult: false, postStop: 'present-null' as const }
    }
  ])('$name retains the latch without cleanup', async ({ behavior }) => {
    const harness = createPersistedMatrixRuntime({ mode, behavior })
    const before = structuredClone(harness.getSession())
    await reclaim(harness)
    expect(harness.stopAndWait).toHaveBeenCalledOnce()
    expect(harness.store.flushOrThrow).not.toHaveBeenCalled()
    expect(harness.getSession()).toEqual(before)
    latch(harness)
    const second = harness.addCandidate({
      mode,
      ptyId: mode === 'runtime-owned-persisted' ? 'serve-ambiguous-second' : 'ambiguous-second-pty',
      tabId: '77777777-7777-4777-8777-777777777777',
      leafId: '88888888-8888-4888-8888-888888888888',
      incarnationId: 'ambiguous-second-incarnation'
    })
    await reclaimCandidate(harness, second)
    expect(harness.stopAndWait).toHaveBeenCalledOnce()
    harness.dispose()
  })

  it('false + provider true + stable same-live releases without retirement', async () => {
    const harness = createPersistedMatrixRuntime({ mode, behavior: { stopResult: false } })
    await reclaim(harness)
    expect(harness.stopAndWait).toHaveBeenCalledOnce()
    expect(harness.store.flushOrThrow).not.toHaveBeenCalled()
    expect(harness.internals.idleTerminalReclaimReservationOrLatch).toBeNull()
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    harness.dispose()
  })

  it.each([
    { name: 'absent', behavior: { postStop: 'absent' as const } },
    { name: 'stable same', behavior: {} },
    { name: 'different non-null', behavior: { postStop: 'replacement' as const } }
  ])('true stop handles $name according to the receipt table', async ({ behavior }) => {
    const harness = createPersistedMatrixRuntime({ mode, behavior })
    await reclaim(harness)
    expect(harness.stopAndWait).toHaveBeenCalledOnce()
    if (behavior.postStop === 'replacement') {
      expect(harness.internals.idleTerminalReclaimReservationOrLatch).toBeNull()
      expect(harness.getSession().tabsByWorktree[WORKTREE_ID]?.[0]?.ptyId).toBe(
        'post-stop-replacement'
      )
      expect(harness.store.flushOrThrow).not.toHaveBeenCalled()
    } else {
      expect(harness.store.flushOrThrow).toHaveBeenCalledOnce()
      expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
      expect(harness.internals.idleTerminalReclaimReservationOrLatch).toBeNull()
    }
    harness.dispose()
  })

  it('true + provider false + present-null never cleans up', async () => {
    const harness = createPersistedMatrixRuntime({ mode, behavior: { postStop: 'present-null' } })
    await reclaim(harness)
    expect(harness.store.flushOrThrow).not.toHaveBeenCalled()
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    latch(harness)
    harness.dispose()
  })

  it('field-identical cloned post-stop identity is an unstable same record', async () => {
    const harness = createPersistedMatrixRuntime({ mode })
    const original = harness.internals.readIdleTerminalReclaimPostStopRecord.bind(harness.internals)
    vi.spyOn(harness.internals, 'readIdleTerminalReclaimPostStopRecord').mockImplementation(
      (id) => {
        const current = original(id)
        return current ? { ...current, recordIdentity: { ...current.recordIdentity } } : null
      }
    )
    await reclaim(harness)
    expect(harness.store.flushOrThrow).not.toHaveBeenCalled()
    latch(harness)
    harness.dispose()
  })
})
