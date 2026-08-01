import { describe, expect, it } from 'vitest'
import { createPersistedMatrixRuntime } from './idle-empty-terminal-reclaim-persisted-matrix-runtime'
import type { PersistedMatrixHarness } from './idle-empty-terminal-reclaim-persisted-matrix-fixture'
import {
  carriers,
  clearBaselineResidue
} from './idle-empty-terminal-reclaim-persisted-carrier-cases'

async function reclaimHot(
  harness: PersistedMatrixHarness,
  candidate: ReturnType<PersistedMatrixHarness['addCandidate']>
) {
  return harness.internals.reclaimHotOnlyIdleTerminal(candidate, {
    enabled: true,
    idleThresholdMs: 5 * 60 * 1000
  })
}

describe('persisted executor carrier mutation matrix', () => {
  it.each(carriers)('$name residue behavior is isolated', async ({ apply, holdsLatch = true }) => {
    const harness = createPersistedMatrixRuntime({
      mode: 'hot-only',
      behavior: { postStop: 'present-null' }
    })
    await reclaimHot(harness, harness.candidate)
    expect(harness.stopAndWait).toHaveBeenCalledOnce()
    const second = harness.addCandidate({
      mode: 'hot-only',
      ptyId: 'carrier-second',
      tabId: '77777777-7777-4777-8777-777777777777',
      leafId: '88888888-8888-4888-8888-888888888888',
      incarnationId: 'carrier-second-incarnation'
    })
    const third = harness.addCandidate({
      mode: 'hot-only',
      ptyId: 'carrier-third',
      tabId: '99999999-9999-4999-8999-999999999999',
      leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      incarnationId: 'carrier-third-incarnation'
    })
    clearBaselineResidue(harness)
    const cleanup = apply(harness)
    harness.internals.releaseIdleTerminalReclaimAmbiguityLatchWhenNaturallyCleared()
    if (!holdsLatch) {
      expect(harness.internals.idleTerminalReclaimReservationOrLatch).toBeNull()
      cleanup()
      harness.refreshGraph()
      await reclaimHot(harness, second)
      expect(harness.stopAndWait).toHaveBeenCalledTimes(2)
      cleanup()
      harness.dispose()
      return
    }
    expect(harness.internals.idleTerminalReclaimReservationOrLatch).toMatchObject({
      kind: 'ambiguity-latch'
    })
    await reclaimHot(harness, second)
    expect(harness.stopAndWait).toHaveBeenCalledOnce()
    cleanup()
    harness.setProviderState(false)
    harness.internals.releaseIdleTerminalReclaimAmbiguityLatchWhenNaturallyCleared()
    expect(harness.internals.idleTerminalReclaimReservationOrLatch).toBeNull()
    harness.setProviderState(undefined)
    harness.refreshGraph()
    await reclaimHot(harness, third)
    expect(harness.stopAndWait).toHaveBeenCalledTimes(2)
    expect(harness.stopAndWait).toHaveBeenLastCalledWith('carrier-third')
    harness.dispose()
  })
})
