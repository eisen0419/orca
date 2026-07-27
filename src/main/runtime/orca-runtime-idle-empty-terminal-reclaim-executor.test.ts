import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluateIdleReclaimCandidate } from './idle-empty-terminal-reclaim'
import {
  HOT_INCARNATION_ID,
  HOT_LEAF_ID,
  HOT_PANE_KEY,
  HOT_PTY_ID,
  HOT_TAB_ID,
  resetReclaimLifecycleFixture,
  SECOND_INCARNATION_ID,
  SECOND_LEAF_ID,
  SECOND_PTY_ID,
  SECOND_TAB_ID,
  WORKTREE_ID,
  createReclaimLifecycleRuntime,
  prepareSecondHotOnlyLifecycle,
  pruneNaturallyExitedPtyRecords,
  syncReclaimGraph
} from './idle-empty-terminal-reclaim-lifecycle-fixture'
import {
  createArchiveTransactionCarrierHarness,
  createMutationTransactionCarrierHarness,
  createPaneRecoveryTransactionCarrierHarness,
  createSleepStateTransactionCarrierHarness,
  createSleepTransactionCarrierHarness,
  type ReclaimTransactionCarrierHarness
} from './idle-empty-terminal-reclaim-transaction-carrier-fixture'
import {
  createHotOnlyRuntime,
  fullyEligibleHotCandidate,
  type RuntimeIdleReclaimInternals
} from './idle-empty-terminal-reclaim-hot-only-fixture'
import type { OrcaRuntimeService } from './orca-runtime'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetReclaimLifecycleFixture()
})

describe('idle empty-terminal reclaim hot-only executor', () => {
  it('reads provider-session and renderer-visibility authorities, degrading each unreadable authority to null', async () => {
    let live = true
    let providerSession = false
    const withAuthorities = createHotOnlyRuntime({
      stopAndWait: vi.fn(async () => true),
      hasPty: () => live,
      getAgentStatusSnapshot: () =>
        providerSession
          ? [
              {
                paneKey: HOT_PANE_KEY,
                state: 'done',
                prompt: '',
                connectionId: null,
                receivedAt: 1,
                stateStartedAt: 1,
                providerSession: { key: 'session_id', id: 'provider-session-1' }
              }
            ]
          : []
    })
    const [safe] = await withAuthorities.internals.collectIdleEmptyTerminalReclaimCandidates()

    expect(safe).toMatchObject({ hasProviderSession: false, rendererVisibility: 'hidden' })
    expect(
      evaluateIdleReclaimCandidate(
        { ...fullyEligibleHotCandidate(), hasProviderSession: null },
        { enabled: true },
        60 * 60 * 1000
      )
    ).toEqual({ eligible: false, reason: 'agent-or-orchestration-owned' })
    expect(
      evaluateIdleReclaimCandidate(fullyEligibleHotCandidate(), { enabled: true }, 60 * 60 * 1000)
    ).toEqual({ eligible: true, closeMode: 'hot-only' })
    expect(
      evaluateIdleReclaimCandidate(
        { ...fullyEligibleHotCandidate(), rendererVisibility: null },
        { enabled: true },
        60 * 60 * 1000
      )
    ).toEqual({ eligible: false, reason: 'renderer-visible' })
    providerSession = true
    withAuthorities.internals.tabs.set(HOT_TAB_ID, {
      tabId: HOT_TAB_ID,
      worktreeId: WORKTREE_ID,
      rendererVisibility: 'visible'
    })
    const [protectedByAuthorities] =
      await withAuthorities.internals.collectIdleEmptyTerminalReclaimCandidates()
    expect(protectedByAuthorities).toMatchObject({
      hasProviderSession: true,
      rendererVisibility: 'visible'
    })
    withAuthorities.internals.tabs.set(HOT_TAB_ID, {
      tabId: HOT_TAB_ID,
      worktreeId: 'wrong-worktree',
      rendererVisibility: 'visible'
    })
    const [mismatchedRenderer] =
      await withAuthorities.internals.collectIdleEmptyTerminalReclaimCandidates()
    expect(mismatchedRenderer?.rendererVisibility).toBeNull()
    withAuthorities.internals.graphStatus = 'unavailable'
    const [unreadableRenderer] =
      await withAuthorities.internals.collectIdleEmptyTerminalReclaimCandidates()
    expect(unreadableRenderer?.rendererVisibility).toBeNull()
    withAuthorities.runtime.dispose()

    live = true
    const withoutProviderAuthority = createHotOnlyRuntime({
      stopAndWait: vi.fn(async () => true),
      hasPty: () => live,
      includeAgentStatusAuthority: false
    })
    const [unreadableProvider] =
      await withoutProviderAuthority.internals.collectIdleEmptyTerminalReclaimCandidates()
    expect(unreadableProvider?.hasProviderSession).toBeNull()
    withoutProviderAuthority.runtime.dispose()

    const duplicateProviderAuthority = createHotOnlyRuntime({
      stopAndWait: vi.fn(async () => true),
      hasPty: () => true,
      getAgentStatusSnapshot: () => [
        {
          paneKey: HOT_PANE_KEY,
          state: 'done',
          prompt: '',
          connectionId: null,
          receivedAt: 1,
          stateStartedAt: 1,
          providerSession: { key: 'session_id', id: 'provider-session-1' }
        },
        {
          paneKey: HOT_PANE_KEY,
          state: 'done',
          prompt: '',
          connectionId: null,
          receivedAt: 2,
          stateStartedAt: 2,
          providerSession: { key: 'session_id', id: 'provider-session-2' }
        }
      ]
    })
    const [ambiguousProvider] =
      await duplicateProviderAuthority.internals.collectIdleEmptyTerminalReclaimCandidates()
    expect(ambiguousProvider?.hasProviderSession).toBeNull()
    duplicateProviderAuthority.runtime.dispose()
  })

  it('reclaims #10747 through the scheduler, evaluator, executor, and production exit contract', async () => {
    let live = true
    let runtime: OrcaRuntimeService | null = null
    const stopAndWait = vi.fn(async () => {
      live = false
      runtime?.onPtyExit(HOT_PTY_ID, -1, HOT_INCARNATION_ID)
      return true
    })
    const created = createHotOnlyRuntime({
      stopAndWait,
      hasPty: () => live
    })
    runtime = created.runtime
    const { internals, pty, store, spawn } = created
    pty.lastActivityAt = 0
    runtime.setOrchestrationDb({
      getActiveCoordinatorRun: () => undefined,
      getActiveDispatchAssignees: () => []
    } as never)
    const removePersistedTab = vi.spyOn(internals, 'removePersistedHeadlessTerminalTab')
    const closeMobileTab = vi.spyOn(internals, 'closeHeadlessMobileTerminalTab')

    await internals.tickIdleEmptyTerminalReclaim()

    expect(stopAndWait).toHaveBeenCalledWith(HOT_PTY_ID)
    expect(live).toBe(false)
    expect(internals.mobileSessionTabsByWorktree.get(WORKTREE_ID)?.tabs).toEqual([])
    await expect(runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).resolves.toMatchObject({
      tabs: []
    })
    expect(store.createTerminalArchiveStore).not.toHaveBeenCalled()
    expect(removePersistedTab).not.toHaveBeenCalled()
    expect(closeMobileTab).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(internals.ptysById.has(HOT_PTY_ID)).toBe(false)
    expect(internals.handleByPtyId.has(HOT_PTY_ID)).toBe(false)
    expect(internals.handles).toEqual(new Map())
    expect(internals.reclaimInFlightByPtyId).toEqual(new Map())
    runtime.dispose()
  })

  it('reclaims post-stop final output residue through the scheduler', async () => {
    let live = true
    let runtime: OrcaRuntimeService | null = null
    let internals: RuntimeIdleReclaimInternals | null = null
    const stopAndWait = vi.fn(async () => {
      runtime?.onPtyData(HOT_PTY_ID, 'final shell output', Date.now())
      live = false
      runtime?.onPtyExit(HOT_PTY_ID, -1, HOT_INCARNATION_ID)
      // Why: a hot-only candidate has no renderer leaf before stop; leave one residue for the executor to retire.
      internals?.leaves.set(`${HOT_TAB_ID}::${HOT_LEAF_ID}`, {
        tabId: HOT_TAB_ID,
        leafId: HOT_LEAF_ID,
        worktreeId: WORKTREE_ID,
        ptyId: HOT_PTY_ID
      })
      internals?.rebuildLeafPtyIndex()
      return true
    })
    const created = createHotOnlyRuntime({ stopAndWait, hasPty: () => live })
    runtime = created.runtime
    internals = created.internals
    const { pty, store, spawn } = created
    pty.lastActivityAt = 0
    runtime.setOrchestrationDb({
      getActiveCoordinatorRun: () => undefined,
      getActiveDispatchAssignees: () => []
    } as never)

    await internals.tickIdleEmptyTerminalReclaim()

    expect(stopAndWait).toHaveBeenCalledWith(HOT_PTY_ID)
    expect(internals.mobileSessionTabsByWorktree.get(WORKTREE_ID)?.tabs).toEqual([])
    expect(internals.leaves.has(`${HOT_TAB_ID}::${HOT_LEAF_ID}`)).toBe(false)
    expect(internals.ptysById.has(HOT_PTY_ID)).toBe(false)
    expect(internals.handleByPtyId.has(HOT_PTY_ID)).toBe(false)
    expect(internals.handles).toEqual(new Map())
    expect(store.createTerminalArchiveStore).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    runtime.dispose()
  })

  it('preserves a replacement incarnation after a successful stop', async () => {
    let live = true
    let internals: RuntimeIdleReclaimInternals | null = null
    const stopAndWait = vi.fn(async () => {
      live = false
      const replacement = internals?.recordPtyWorktree(HOT_PTY_ID, WORKTREE_ID, {
        connected: true,
        incarnationId: 'replacement-incarnation',
        tabId: HOT_TAB_ID,
        paneKey: HOT_PANE_KEY
      })
      if (replacement) {
        replacement.creationOrigin = 'cli'
      }
      return true
    })
    const created = createHotOnlyRuntime({ stopAndWait, hasPty: () => live })
    internals = created.internals
    const { runtime, pty } = created
    pty.lastActivityAt = 0
    runtime.setOrchestrationDb({
      getActiveCoordinatorRun: () => undefined,
      getActiveDispatchAssignees: () => []
    } as never)

    await internals.tickIdleEmptyTerminalReclaim()

    expect(stopAndWait).toHaveBeenCalledWith(HOT_PTY_ID)
    expect(internals.ptysById.get(HOT_PTY_ID)).toMatchObject({
      incarnationId: 'replacement-incarnation'
    })
    expect(internals.mobileSessionTabsByWorktree.get(WORKTREE_ID)?.tabs).toHaveLength(1)
    expect(internals.handleByPtyId.has(HOT_PTY_ID)).toBe(true)
    runtime.dispose()
  })

  it('completes reclaim when a mobile-session listener throws', async () => {
    let live = true
    let runtime: OrcaRuntimeService | null = null
    let internals: RuntimeIdleReclaimInternals | null = null
    const stopAndWait = vi.fn(async () => {
      live = false
      runtime?.onPtyExit(HOT_PTY_ID, -1, HOT_INCARNATION_ID, {
        skipMobileSessionRetirement: true
      })
      internals?.leaves.set(`${HOT_TAB_ID}::${HOT_LEAF_ID}`, {
        tabId: HOT_TAB_ID,
        leafId: HOT_LEAF_ID,
        worktreeId: WORKTREE_ID,
        ptyId: HOT_PTY_ID
      })
      internals?.rebuildLeafPtyIndex()
      return true
    })
    const created = createHotOnlyRuntime({ stopAndWait, hasPty: () => live })
    runtime = created.runtime
    internals = created.internals
    const { pty } = created
    pty.lastActivityAt = 0
    runtime.setOrchestrationDb({
      getActiveCoordinatorRun: () => undefined,
      getActiveDispatchAssignees: () => []
    } as never)
    const unsubscribe = runtime.onMobileSessionTabsChanged(() => {
      throw new Error('listener failure')
    })
    const reportListenerFailure = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await internals.tickIdleEmptyTerminalReclaim()

    expect(stopAndWait).toHaveBeenCalledWith(HOT_PTY_ID)
    expect(internals.mobileSessionTabsByWorktree.get(WORKTREE_ID)?.tabs).toEqual([])
    expect(internals.leaves.has(`${HOT_TAB_ID}::${HOT_LEAF_ID}`)).toBe(false)
    expect(internals.ptysById.has(HOT_PTY_ID)).toBe(false)
    expect(internals.handleByPtyId.has(HOT_PTY_ID)).toBe(false)
    expect(internals.handles).toEqual(new Map())
    expect(reportListenerFailure).toHaveBeenCalled()
    unsubscribe()
    runtime.dispose()
  })

  it('preserves a replacement registered by a mobile-session listener', async () => {
    let live = true
    let runtime: OrcaRuntimeService | null = null
    const stopAndWait = vi.fn(async () => {
      live = false
      runtime?.onPtyExit(HOT_PTY_ID, -1, HOT_INCARNATION_ID, {
        skipMobileSessionRetirement: true
      })
      return true
    })
    const created = createHotOnlyRuntime({ stopAndWait, hasPty: () => live })
    runtime = created.runtime
    const { internals, pty } = created
    pty.lastActivityAt = 0
    runtime.setOrchestrationDb({
      getActiveCoordinatorRun: () => undefined,
      getActiveDispatchAssignees: () => []
    } as never)
    const unsubscribe = runtime.onMobileSessionTabsChanged(() => {
      runtime?.registerPty(HOT_PTY_ID, WORKTREE_ID, null, {
        tabId: HOT_TAB_ID,
        leafId: HOT_LEAF_ID,
        incarnationId: 'replacement-during-notification'
      })
    })

    await internals.tickIdleEmptyTerminalReclaim()

    expect(stopAndWait).toHaveBeenCalledWith(HOT_PTY_ID)
    expect(internals.ptysById.get(HOT_PTY_ID)).toMatchObject({
      connected: true,
      incarnationId: 'replacement-during-notification'
    })
    unsubscribe()
    runtime.dispose()
  })

  it('preserves a connected replacement without an incarnation', async () => {
    let live = true
    let runtime: OrcaRuntimeService | null = null
    let internals: RuntimeIdleReclaimInternals | null = null
    const stopAndWait = vi.fn(async () => {
      live = false
      internals?.ptysById.delete(HOT_PTY_ID)
      runtime?.registerPty(HOT_PTY_ID, WORKTREE_ID)
      return true
    })
    const created = createHotOnlyRuntime({ stopAndWait, hasPty: () => live })
    runtime = created.runtime
    internals = created.internals
    const { pty } = created
    pty.lastActivityAt = 0
    runtime.setOrchestrationDb({
      getActiveCoordinatorRun: () => undefined,
      getActiveDispatchAssignees: () => []
    } as never)

    await internals.tickIdleEmptyTerminalReclaim()

    expect(stopAndWait).toHaveBeenCalledWith(HOT_PTY_ID)
    expect(internals.ptysById.get(HOT_PTY_ID)).toMatchObject({
      connected: true,
      incarnationId: null
    })
    runtime.dispose()
  })

  it('rejects a generation changed before the fence and leaves no claim behind', async () => {
    let live = true
    const stopAndWait = vi.fn(async () => true)
    const { runtime, internals, pty } = createHotOnlyRuntime({
      stopAndWait,
      hasPty: () => live
    })
    const captured = fullyEligibleHotCandidate(pty.activityGeneration)
    pty.activityGeneration += 1

    await expect(
      internals.reclaimHotOnlyIdleTerminal(captured, { enabled: true })
    ).resolves.toBeNull()
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(internals.reclaimInFlightByPtyId).toEqual(new Map())
    runtime.dispose()
  })

  it('aborts before stop when the captured origin no longer matches the live PTY', async () => {
    const live = true
    const stopAndWait = vi.fn(async () => true)
    const { runtime, internals, pty } = createHotOnlyRuntime({ stopAndWait, hasPty: () => live })
    const candidate = fullyEligibleHotCandidate(pty.activityGeneration)
    pty.creationOrigin = 'user'
    vi.spyOn(internals, 'collectIdleEmptyTerminalReclaimConfirmation').mockResolvedValue(candidate)

    await expect(
      internals.reclaimHotOnlyIdleTerminal(candidate, { enabled: true })
    ).resolves.toMatchObject({
      decision: { eligible: false, reason: 'topology-or-binding-invalid' },
      reclaimed: false
    })
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(internals.reclaimInFlightByPtyId).toEqual(new Map())
    runtime.dispose()
  })

  it('aborts before stop when activity changes during final confirmation', async () => {
    let live = true
    const stopAndWait = vi.fn(async () => true)
    const { runtime, internals, pty, store } = createHotOnlyRuntime({
      stopAndWait,
      hasPty: () => live
    })
    const candidate = fullyEligibleHotCandidate(pty.activityGeneration)
    vi.spyOn(internals, 'collectIdleEmptyTerminalReclaimConfirmation').mockImplementation(
      async () => {
        pty.activityGeneration += 1
        return candidate
      }
    )

    await expect(
      internals.reclaimHotOnlyIdleTerminal(candidate, { enabled: true })
    ).resolves.toMatchObject({
      decision: { eligible: false, reason: 'final-confirmation-or-claim-missing' },
      reclaimed: false
    })
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(internals.mobileSessionTabsByWorktree.get(WORKTREE_ID)?.tabs).toHaveLength(1)
    expect(internals.ptysById.has(HOT_PTY_ID)).toBe(true)
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
    expect(store.flushOrThrow).not.toHaveBeenCalled()
    expect(store.createTerminalArchiveStore).not.toHaveBeenCalled()
    expect(internals.reclaimInFlightByPtyId).toEqual(new Map())
    runtime.dispose()
  })

  it('fences concurrent reclaim attempts and releases the claim after provider failure', async () => {
    let live = true
    let runtime: OrcaRuntimeService | null = null
    let releaseStop!: () => void
    const stop = new Promise<boolean>((resolve) => {
      releaseStop = () => resolve(true)
    })
    let stopCalls = 0
    const stopAndWait = vi.fn(async () => {
      stopCalls += 1
      const stopped = stopCalls === 1 ? await stop : true
      live = false
      runtime?.onPtyExit(HOT_PTY_ID, -1, HOT_INCARNATION_ID)
      return stopped
    })
    const created = createHotOnlyRuntime({ stopAndWait, hasPty: () => live })
    runtime = created.runtime
    const { internals, pty } = created
    const candidate = fullyEligibleHotCandidate(pty.activityGeneration)
    vi.spyOn(internals, 'collectIdleEmptyTerminalReclaimConfirmation').mockResolvedValue(candidate)

    const first = internals.reclaimHotOnlyIdleTerminal(candidate, { enabled: true })
    await vi.waitFor(() => expect(stopAndWait).toHaveBeenCalledOnce())
    const second = internals.reclaimHotOnlyIdleTerminal(candidate, { enabled: true })
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(stopAndWait).toHaveBeenCalledOnce()
      await expect(second).resolves.toBeNull()
      releaseStop()
      await expect(first).resolves.toMatchObject({ reclaimed: true })
      expect(internals.reclaimInFlightByPtyId).toEqual(new Map())
    } finally {
      releaseStop()
    }
    runtime.dispose()

    const throwing = createHotOnlyRuntime({
      stopAndWait: vi.fn(async () => {
        throw new Error('provider stopped responding')
      }),
      hasPty: () => true
    })
    const throwingCandidate = fullyEligibleHotCandidate(throwing.pty.activityGeneration)
    vi.spyOn(throwing.internals, 'collectIdleEmptyTerminalReclaimConfirmation').mockResolvedValue(
      throwingCandidate
    )

    await expect(
      throwing.internals.reclaimHotOnlyIdleTerminal(throwingCandidate, { enabled: true })
    ).resolves.toMatchObject({
      decision: { eligible: false, reason: 'final-confirmation-or-claim-missing' },
      reclaimed: false
    })
    expect(throwing.internals.reclaimInFlightByPtyId).toEqual(new Map())
    throwing.runtime.dispose()
  })

  it('aborts before stop when a persisted row appears during final confirmation', async () => {
    let live = true
    const stopAndWait = vi.fn(async () => true)
    const { runtime, internals, pty } = createHotOnlyRuntime({ stopAndWait, hasPty: () => live })
    const candidate = fullyEligibleHotCandidate(pty.activityGeneration)
    const persisted = { ...candidate, isPersisted: true, rendererOwnsPersistedTab: false }
    vi.spyOn(internals, 'collectIdleEmptyTerminalReclaimConfirmation').mockResolvedValue(persisted)

    await expect(
      internals.reclaimHotOnlyIdleTerminal(candidate, { enabled: true })
    ).resolves.toMatchObject({
      decision: { eligible: false, reason: 'topology-or-binding-invalid' },
      reclaimed: false
    })
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(internals.reclaimInFlightByPtyId).toEqual(new Map())
    runtime.dispose()
  })
})

function secondHotOnlyCandidate() {
  return {
    ...fullyEligibleHotCandidate(1),
    tabId: SECOND_TAB_ID,
    leafId: SECOND_LEAF_ID,
    ptyId: SECOND_PTY_ID,
    incarnationId: SECOND_INCARNATION_ID,
    expectedIncarnationId: SECOND_INCARNATION_ID,
    activityGeneration: 1,
    expectedActivityGeneration: 1
  }
}

async function reclaimSecondHotOnlyTerminal(internals: RuntimeIdleReclaimInternals) {
  const candidate = secondHotOnlyCandidate()
  return internals.reclaimHotOnlyIdleTerminal(candidate, {
    enabled: true,
    idleThresholdMs: 5 * 60 * 1000
  })
}

async function expectTransactionCarrierToHoldAndThenRelease(
  createCarrier: () => Promise<ReclaimTransactionCarrierHarness>,
  bypassAdmission = false
): Promise<void> {
  const carrier = await createCarrier()
  if (bypassAdmission) {
    vi.spyOn(carrier.internals, 'collectIdleEmptyTerminalReclaimConfirmation').mockResolvedValue(
      secondHotOnlyCandidate()
    )
  }
  await reclaimSecondHotOnlyTerminal(carrier.internals)
  expect(carrier.stopAndWait).toHaveBeenCalledOnce()
  await carrier.releaseCarrier()
  await expect(reclaimSecondHotOnlyTerminal(carrier.internals)).resolves.toMatchObject({
    reclaimed: true
  })
  expect(carrier.stopAndWait).toHaveBeenCalledTimes(2)
  expect(carrier.stopAndWait).toHaveBeenLastCalledWith(SECOND_PTY_ID)
  carrier.runtime.dispose()
}

describe('idle terminal reclaim ambiguity latch', () => {
  it('latches a null post-stop identity and prevents a second hot-only stop', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { runtime, internals, stopAndWait, livePtyIds } =
      await createReclaimLifecycleRuntime('null-ambiguity')

    prepareSecondHotOnlyLifecycle(runtime, livePtyIds)
    await reclaimSecondHotOnlyTerminal(internals)

    expect(stopAndWait).toHaveBeenCalledOnce()
    expect(stopAndWait).toHaveBeenCalledWith(HOT_PTY_ID)
    runtime.dispose()
  })

  it('releases capacity after ordinary lifecycle cleanup completes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { runtime, internals, stopAndWait, livePtyIds } =
      await createReclaimLifecycleRuntime('normal')

    prepareSecondHotOnlyLifecycle(runtime, livePtyIds)
    await expect(reclaimSecondHotOnlyTerminal(internals)).resolves.toMatchObject({
      reclaimed: true
    })

    expect(stopAndWait).toHaveBeenCalledTimes(2)
    expect(stopAndWait).toHaveBeenLastCalledWith(SECOND_PTY_ID)
    runtime.dispose()
  })

  it('preserves a different non-null replacement with a cleared pane identity and releases capacity', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { runtime, internals, stopAndWait, livePtyIds } =
      await createReclaimLifecycleRuntime('replacement')

    prepareSecondHotOnlyLifecycle(runtime, livePtyIds)
    await reclaimSecondHotOnlyTerminal(internals)

    expect(stopAndWait).toHaveBeenCalledTimes(2)
    expect(stopAndWait).toHaveBeenLastCalledWith(SECOND_PTY_ID)
    runtime.dispose()
  })

  it('releases the latch after a different PTY adopts the captured leaf alias', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { runtime, internals, stopAndWait, livePtyIds } =
      await createReclaimLifecycleRuntime('null-ambiguity')
    const second = { tabId: SECOND_TAB_ID, leafId: SECOND_LEAF_ID, ptyId: SECOND_PTY_ID }
    const replacement = {
      tabId: HOT_TAB_ID,
      leafId: HOT_LEAF_ID,
      ptyId: 'pty-reclaim-different-replacement'
    }

    prepareSecondHotOnlyLifecycle(runtime, livePtyIds)
    runtime.onPtySpawned(replacement.ptyId, 'different-replacement', { awaitsRegistration: false })
    runtime.registerPty(replacement.ptyId, WORKTREE_ID, null, {
      tabId: replacement.tabId,
      leafId: replacement.leafId,
      incarnationId: 'different-replacement'
    })
    runtime.preAllocateHandleForPty(replacement.ptyId)
    syncReclaimGraph(runtime, {
      tabs: [replacement],
      leaves: [replacement],
      mobile: [replacement, second]
    })
    runtime.onPtyExit(HOT_PTY_ID, 0)
    pruneNaturallyExitedPtyRecords(runtime)
    syncReclaimGraph(runtime, {
      tabs: [replacement],
      leaves: [replacement],
      mobile: [replacement, second]
    })
    await reclaimSecondHotOnlyTerminal(internals)

    expect(stopAndWait).toHaveBeenCalledTimes(2)
    expect(stopAndWait).toHaveBeenLastCalledWith(SECOND_PTY_ID)
    runtime.dispose()
  })

  it('keeps the latch when the captured leaf alias remains bound to its PTY', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { runtime, internals, stopAndWait, livePtyIds } =
      await createReclaimLifecycleRuntime('null-ambiguity')
    const second = { tabId: SECOND_TAB_ID, leafId: SECOND_LEAF_ID, ptyId: SECOND_PTY_ID }
    const samePtyReplacement = { tabId: HOT_TAB_ID, leafId: HOT_LEAF_ID, ptyId: HOT_PTY_ID }

    prepareSecondHotOnlyLifecycle(runtime, livePtyIds)
    runtime.onPtySpawned(HOT_PTY_ID, 'same-pty-replacement', { awaitsRegistration: false })
    runtime.registerPty(HOT_PTY_ID, WORKTREE_ID, null, {
      tabId: HOT_TAB_ID,
      leafId: HOT_LEAF_ID,
      incarnationId: 'same-pty-replacement'
    })
    runtime.preAllocateHandleForPty(HOT_PTY_ID)
    syncReclaimGraph(runtime, {
      tabs: [samePtyReplacement],
      leaves: [samePtyReplacement],
      mobile: [samePtyReplacement, second]
    })
    syncReclaimGraph(runtime, {
      tabs: [samePtyReplacement],
      leaves: [samePtyReplacement],
      mobile: [samePtyReplacement, second]
    })
    await reclaimSecondHotOnlyTerminal(internals)

    expect(stopAndWait).toHaveBeenCalledOnce()
    expect(stopAndWait).toHaveBeenCalledWith(HOT_PTY_ID)
    runtime.dispose()
  })

  it('holds while residue remains and passively releases only after it disappears', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { runtime, internals, stopAndWait, livePtyIds } =
      await createReclaimLifecycleRuntime('null-ambiguity')
    const second = { tabId: SECOND_TAB_ID, leafId: SECOND_LEAF_ID, ptyId: SECOND_PTY_ID }

    prepareSecondHotOnlyLifecycle(runtime, livePtyIds)
    await reclaimSecondHotOnlyTerminal(internals)
    await reclaimSecondHotOnlyTerminal(internals)

    expect(stopAndWait).toHaveBeenCalledOnce()
    runtime.onPtyExit(HOT_PTY_ID, 0)
    pruneNaturallyExitedPtyRecords(runtime)
    syncReclaimGraph(runtime, { tabs: [], leaves: [], mobile: second })
    await reclaimSecondHotOnlyTerminal(internals)

    expect(stopAndWait).toHaveBeenCalledTimes(2)
    expect(stopAndWait).toHaveBeenLastCalledWith(SECOND_PTY_ID)
    runtime.dispose()
  })

  it('keeps the latch while headlessTerminalArchiveByOperationId is in flight', async () => {
    await expectTransactionCarrierToHoldAndThenRelease(createArchiveTransactionCarrierHarness, true)
  })

  it('keeps the latch while terminalSleepByWorktreeId is in flight', async () => {
    await expectTransactionCarrierToHoldAndThenRelease(createSleepTransactionCarrierHarness, true)
  })

  it('keeps the latch while terminalMutationTailByWorktreeId remains', async () => {
    await expectTransactionCarrierToHoldAndThenRelease(createMutationTransactionCarrierHarness)
  })

  it('keeps the latch while terminalSleepStateByWorktreeId retains the latched PTY', async () => {
    await expectTransactionCarrierToHoldAndThenRelease(createSleepStateTransactionCarrierHarness)
  })

  it('keeps the latch while terminalPaneRecoveryByIdentity is in flight', async () => {
    await expectTransactionCarrierToHoldAndThenRelease(createPaneRecoveryTransactionCarrierHarness)
  })

  it('does not retain the latch for its own completed reclaim claim', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { runtime, internals, stopAndWait, livePtyIds } =
      await createReclaimLifecycleRuntime('null-ambiguity')
    const second = { tabId: SECOND_TAB_ID, leafId: SECOND_LEAF_ID, ptyId: SECOND_PTY_ID }

    prepareSecondHotOnlyLifecycle(runtime, livePtyIds)
    runtime.onPtyExit(HOT_PTY_ID, 0)
    pruneNaturallyExitedPtyRecords(runtime)
    syncReclaimGraph(runtime, { tabs: [], leaves: [], mobile: second })
    await expect(reclaimSecondHotOnlyTerminal(internals)).resolves.toMatchObject({
      reclaimed: true
    })

    expect(stopAndWait).toHaveBeenCalledTimes(2)
    expect(stopAndWait).toHaveBeenLastCalledWith(SECOND_PTY_ID)
    runtime.dispose()
  })

  it('keeps the latch for a layout-only terminal PTY carrier', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { runtime, internals, stopAndWait, livePtyIds } =
      await createReclaimLifecycleRuntime('null-ambiguity')
    const second = { tabId: SECOND_TAB_ID, leafId: SECOND_LEAF_ID, ptyId: SECOND_PTY_ID }
    const layoutOnlyTarget = {
      tabId: HOT_TAB_ID,
      leafId: HOT_LEAF_ID,
      ptyId: HOT_PTY_ID,
      tabPtyId: null
    }

    prepareSecondHotOnlyLifecycle(runtime, livePtyIds, [layoutOnlyTarget])
    runtime.onPtyExit(HOT_PTY_ID, 0)
    pruneNaturallyExitedPtyRecords(runtime)
    syncReclaimGraph(runtime, { tabs: [], leaves: [], mobile: [layoutOnlyTarget, second] })
    await reclaimSecondHotOnlyTerminal(internals)

    expect(stopAndWait).toHaveBeenCalledOnce()
    expect(stopAndWait).toHaveBeenCalledWith(HOT_PTY_ID)
    runtime.dispose()
  })

  it('keeps the latch for an orphaned same-PTY handle after its captured token disappears', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { runtime, internals, stopAndWait, livePtyIds } = await createReclaimLifecycleRuntime(
      'null-ambiguity-without-leaf'
    )
    const second = { tabId: SECOND_TAB_ID, leafId: SECOND_LEAF_ID, ptyId: SECOND_PTY_ID }
    const alternateLeaf = {
      tabId: '99999999-9999-4999-8999-999999999999',
      leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ptyId: HOT_PTY_ID
    }

    prepareSecondHotOnlyLifecycle(runtime, livePtyIds)
    runtime.registerPreAllocatedHandleForPty(HOT_PTY_ID, 'term_reclaim_other_handle')
    syncReclaimGraph(runtime, { tabs: [alternateLeaf], leaves: [alternateLeaf], mobile: second })
    runtime.registerPreAllocatedHandleForPty(HOT_PTY_ID, 'term_reclaim_current_handle')
    syncReclaimGraph(runtime, { tabs: [], leaves: [], mobile: second })
    runtime.onPtyExit(HOT_PTY_ID, 0)
    pruneNaturallyExitedPtyRecords(runtime)
    syncReclaimGraph(runtime, { tabs: [], leaves: [], mobile: second })
    await reclaimSecondHotOnlyTerminal(internals)

    expect(stopAndWait).toHaveBeenCalledOnce()
    expect(stopAndWait).toHaveBeenCalledWith(HOT_PTY_ID)
    runtime.dispose()
  })

  it.each(['reloading', 'unavailable'] as const)(
    'keeps the latch while the incoming graph is %s',
    async (graphStatus) => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      const { runtime, internals, stopAndWait, livePtyIds } =
        await createReclaimLifecycleRuntime('null-ambiguity')
      const second = { tabId: SECOND_TAB_ID, leafId: SECOND_LEAF_ID, ptyId: SECOND_PTY_ID }

      prepareSecondHotOnlyLifecycle(runtime, livePtyIds)
      runtime.onPtyExit(HOT_PTY_ID, 0)
      pruneNaturallyExitedPtyRecords(runtime)
      internals.graphStatus = graphStatus
      syncReclaimGraph(runtime, { tabs: [], leaves: [], mobile: second })
      await reclaimSecondHotOnlyTerminal(internals)

      expect(stopAndWait).toHaveBeenCalledOnce()
      expect(stopAndWait).toHaveBeenCalledWith(HOT_PTY_ID)
      runtime.dispose()
    }
  )
})
