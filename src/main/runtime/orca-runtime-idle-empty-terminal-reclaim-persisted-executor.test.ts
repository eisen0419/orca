import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/types'
import {
  HOT_INCARNATION_ID,
  HOT_LEAF_ID,
  HOT_PANE_KEY,
  HOT_PTY_ID,
  HOT_TAB_ID,
  resetReclaimLifecycleFixture,
  syncReclaimGraph,
  WORKTREE_ID
} from './idle-empty-terminal-reclaim-lifecycle-fixture'
import {
  createHotOnlyRuntime,
  type RuntimeIdleReclaimInternals
} from './idle-empty-terminal-reclaim-hot-only-fixture'
import type { OrcaRuntimeService } from './orca-runtime'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetReclaimLifecycleFixture()
})

describe.each([
  { name: 'renderer-owned persisted terminal', owner: 'renderer' as const, ptyId: HOT_PTY_ID },
  {
    name: 'runtime-owned persisted headless terminal',
    owner: 'runtime' as const,
    ptyId: 'serve-persisted'
  }
])('idle empty-terminal reclaim $name executor', ({ owner, ptyId }) => {
  it('uses the public tick lifecycle to stop, durably retire, then publish exact absence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const created = createPersistedRuntime({ owner, ptyId })
    vi.setSystemTime(6 * 60 * 1000)

    await created.internals.tickIdleEmptyTerminalReclaim()

    expect(created.stopAndWait).toHaveBeenCalledOnce()
    expect(created.stopAndWait).toHaveBeenCalledWith(ptyId)
    expect(created.store.flushOrThrow).toHaveBeenCalledOnce()
    expect(created.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(created.getSession().terminalLayoutsByTabId[HOT_TAB_ID]).toBeUndefined()
    expect(created.internals.mobileSessionTabsByWorktree.get(WORKTREE_ID)?.tabs).toEqual([])
    expect(created.internals.idleTerminalReclaimReservationOrLatch).toBeNull()
    created.runtime.dispose()
  })

  it('fails closed for a field-identical cloned post-stop record identity', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const created = createPersistedRuntime({ owner, ptyId })
    const original = created.internals.readIdleTerminalReclaimPostStopRecord.bind(created.internals)
    vi.spyOn(created.internals, 'readIdleTerminalReclaimPostStopRecord').mockImplementation(
      (id) => {
        const current = original(id)
        return current ? { ...current, recordIdentity: { ...current.recordIdentity } } : null
      }
    )
    vi.setSystemTime(6 * 60 * 1000)

    await created.internals.tickIdleEmptyTerminalReclaim()

    expect(created.stopAndWait).toHaveBeenCalledOnce()
    expect(created.store.flushOrThrow).not.toHaveBeenCalled()
    expect(created.getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    expect(created.internals.idleTerminalReclaimReservationOrLatch).toMatchObject({
      kind: 'ambiguity-latch'
    })
    await created.internals.tickIdleEmptyTerminalReclaim()
    expect(created.stopAndWait).toHaveBeenCalledOnce()
    created.runtime.dispose()
  })

  it('releases without retirement when stop=false leaves the stable provider record live', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const created = createPersistedRuntime({ owner, ptyId, stopResult: false })
    vi.setSystemTime(6 * 60 * 1000)

    await created.internals.tickIdleEmptyTerminalReclaim()

    expect(created.stopAndWait).toHaveBeenCalledOnce()
    expect(created.store.flushOrThrow).not.toHaveBeenCalled()
    expect(created.getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    expect(created.internals.idleTerminalReclaimReservationOrLatch).toBeNull()
    created.runtime.dispose()
  })

  it('does not stop when the shared slot is latched by another close mode', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const created = createPersistedRuntime({ owner, ptyId })
    created.internals.idleTerminalReclaimReservationOrLatch = {
      kind: 'ambiguity-latch',
      latch: {
        mode: 'hot-only',
        claimIncarnationId: 'other-incarnation',
        worktreeId: WORKTREE_ID,
        tabId: HOT_TAB_ID,
        leafId: HOT_LEAF_ID,
        ptyId,
        ownerKind: 'hot-only',
        capturedTopologyRevision: null,
        createdAt: 0,
        reason: 'stop-result-ambiguous'
      }
    }
    vi.setSystemTime(6 * 60 * 1000)

    await created.internals.tickIdleEmptyTerminalReclaim()

    expect(created.stopAndWait).not.toHaveBeenCalled()
    expect(created.store.flushOrThrow).not.toHaveBeenCalled()
    expect(created.getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    created.runtime.dispose()
  })

  it('does not stop for a pre-stop persisted replacement', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const created = createPersistedRuntime({ owner, ptyId })
    const originalConfirmation = created.internals.collectIdleEmptyTerminalReclaimConfirmation.bind(
      created.internals
    )
    vi.spyOn(created.internals, 'collectIdleEmptyTerminalReclaimConfirmation').mockImplementation(
      async (candidate) => {
        const confirmed = await originalConfirmation(candidate)
        replacePersistedBinding(created.getSession(), ptyId, 'pre-stop-replacement')
        return confirmed
      }
    )
    vi.setSystemTime(6 * 60 * 1000)

    await created.internals.tickIdleEmptyTerminalReclaim()

    expect(created.stopAndWait).not.toHaveBeenCalled()
    expect(created.store.flushOrThrow).not.toHaveBeenCalled()
    expect(created.getSession().tabsByWorktree[WORKTREE_ID]?.[0]?.ptyId).toBe(
      'pre-stop-replacement'
    )
    expect(created.internals.idleTerminalReclaimReservationOrLatch).toBeNull()
    created.runtime.dispose()
  })

  it('preserves a true post-stop persisted replacement and releases the slot', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const created = createPersistedRuntime({ owner, ptyId, replaceDuringStop: true })
    vi.setSystemTime(6 * 60 * 1000)

    await created.internals.tickIdleEmptyTerminalReclaim()

    expect(created.stopAndWait).toHaveBeenCalledOnce()
    expect(created.store.flushOrThrow).not.toHaveBeenCalled()
    expect(created.getSession().tabsByWorktree[WORKTREE_ID]?.[0]?.ptyId).toBe(
      'post-stop-replacement'
    )
    expect(created.getSession().terminalPtyIncarnationsByPaneKey?.[HOT_PANE_KEY]).toBe(
      'post-stop-replacement-incarnation'
    )
    expect(created.internals.idleTerminalReclaimReservationOrLatch).toBeNull()
    created.runtime.dispose()
  })

  it.each([
    {
      name: 'flush failure',
      configure: (created: ReturnType<typeof createPersistedRuntime>) => {
        created.store.flushOrThrow.mockImplementation(() => {
          throw new Error('disk-full')
        })
      }
    },
    {
      name: 'readback failure',
      configure: (created: ReturnType<typeof createPersistedRuntime>) => {
        created.store.setWorkspaceSession.mockImplementation(() => undefined)
      }
    }
  ])('restores public session and latches on $name', async ({ configure }) => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const created = createPersistedRuntime({ owner, ptyId })
    const before = created.getSession()
    configure(created)
    vi.setSystemTime(6 * 60 * 1000)

    await created.internals.tickIdleEmptyTerminalReclaim()

    expect(created.stopAndWait).toHaveBeenCalledOnce()
    expect(created.getSession()).toBe(before)
    expect(created.getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    expect(created.internals.mobileSessionTabsByWorktree.get(WORKTREE_ID)?.tabs).toHaveLength(1)
    expect(created.internals.idleTerminalReclaimReservationOrLatch).toMatchObject({
      kind: 'ambiguity-latch'
    })
    created.runtime.dispose()
  })
})

function createPersistedRuntime(args: {
  owner: 'renderer' | 'runtime'
  ptyId: string
  stopResult?: boolean
  replaceDuringStop?: boolean
}): {
  runtime: OrcaRuntimeService
  internals: RuntimeIdleReclaimInternals & {
    idleTerminalReclaimReservationOrLatch: unknown
    readIdleTerminalReclaimPostStopRecord: (ptyId: string) => {
      recordIdentity: object
      ptyId: string
      worktreeId: string
      tabId: string | null
      leafId: string | null
      incarnationId: string | null
      connected: boolean
    } | null
  }
  stopAndWait: ReturnType<typeof vi.fn>
  store: {
    setWorkspaceSession: ReturnType<typeof vi.fn>
    restoreWorkspaceSessionAfterFailedFlush: ReturnType<typeof vi.fn>
    flushOrThrow: ReturnType<typeof vi.fn>
  }
  getSession: () => WorkspaceSessionState
} {
  let live = true
  let internals: RuntimeIdleReclaimInternals | null = null
  const stopAndWait = vi.fn(async () => {
    if (args.stopResult !== false) {
      live = false
      const pty = internals?.ptysById.get(args.ptyId) as { connected?: boolean } | undefined
      if (pty) {
        pty.connected = false
      }
      if (args.replaceDuringStop) {
        const replacement = internals?.recordPtyWorktree(args.ptyId, WORKTREE_ID, {
          connected: true,
          incarnationId: 'post-stop-replacement-incarnation',
          tabId: HOT_TAB_ID,
          paneKey: HOT_PANE_KEY
        })
        if (replacement) {
          replacement.creationOrigin = 'cli'
        }
        replacePersistedBinding(persistedSession, args.ptyId, 'post-stop-replacement')
        live = true
      }
    }
    return args.stopResult ?? true
  })
  const created = createHotOnlyRuntime({ stopAndWait, hasPty: () => live })
  internals = created.internals
  const incarnationId =
    args.owner === 'runtime' ? 'runtime-persisted-incarnation' : HOT_INCARNATION_ID
  if (args.ptyId !== HOT_PTY_ID) {
    created.internals.ptysById.delete(HOT_PTY_ID)
    created.internals.handleByPtyId.delete(HOT_PTY_ID)
    created.internals.recordPtyWorktree(args.ptyId, WORKTREE_ID, {
      connected: true,
      incarnationId,
      tabId: HOT_TAB_ID,
      paneKey: HOT_PANE_KEY
    }).creationOrigin = 'cli'
    created.internals.launchFactsAuthoritativeIncarnationByPtyId.delete(HOT_PTY_ID)
    created.internals.launchFactsAuthoritativeIncarnationByPtyId.set(args.ptyId, incarnationId)
    created.runtime.preAllocateHandleForPty(args.ptyId)
  }
  const session = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: HOT_TAB_ID,
          ptyId: args.ptyId,
          worktreeId: WORKTREE_ID,
          title: 'Background shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0,
          creationOrigin: 'cli' as const
        }
      ]
    },
    terminalLayoutsByTabId: {
      [HOT_TAB_ID]: {
        root: { type: 'leaf' as const, leafId: HOT_LEAF_ID },
        activeLeafId: HOT_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [HOT_LEAF_ID]: args.ptyId }
      }
    },
    terminalPtyIncarnationsByPaneKey: { [HOT_PANE_KEY]: incarnationId }
  } satisfies WorkspaceSessionState
  let persistedSession: WorkspaceSessionState = session
  const store = created.store as unknown as {
    getWorkspaceSession: () => WorkspaceSessionState
    setWorkspaceSession: ReturnType<typeof vi.fn>
    restoreWorkspaceSessionAfterFailedFlush: ReturnType<typeof vi.fn>
    flushOrThrow: ReturnType<typeof vi.fn>
  }
  store.getWorkspaceSession = () => persistedSession
  store.setWorkspaceSession = vi.fn((next: WorkspaceSessionState) => {
    persistedSession = next
  })
  store.restoreWorkspaceSessionAfterFailedFlush = vi.fn((previous: WorkspaceSessionState) => {
    persistedSession = previous
  })
  if (args.owner === 'renderer') {
    syncReclaimGraph(created.runtime, {
      tabs: [{ tabId: HOT_TAB_ID, leafId: HOT_LEAF_ID, ptyId: args.ptyId }],
      leaves: [{ tabId: HOT_TAB_ID, leafId: HOT_LEAF_ID, ptyId: args.ptyId }],
      mobile: { tabId: HOT_TAB_ID, leafId: HOT_LEAF_ID, ptyId: args.ptyId }
    })
  } else {
    syncReclaimGraph(created.runtime, {
      tabs: [],
      leaves: [],
      mobile: { tabId: HOT_TAB_ID, leafId: HOT_LEAF_ID, ptyId: args.ptyId }
    })
  }
  const pty = created.internals.ptysById.get(args.ptyId) as { lastActivityAt: number } | undefined
  if (pty) {
    pty.lastActivityAt = 0
  }
  created.runtime.setOrchestrationDb({
    getActiveCoordinatorRun: () => undefined,
    getActiveDispatchAssignees: () => [],
    getActiveDispatchForTerminal: () => undefined
  } as never)
  return {
    runtime: created.runtime,
    internals: created.internals as never,
    stopAndWait,
    store,
    getSession: () => persistedSession
  }
}

function replacePersistedBinding(
  session: WorkspaceSessionState,
  priorPtyId: string,
  replacementPtyId: string
): void {
  const tab = session.tabsByWorktree[WORKTREE_ID]?.[0]
  if (tab?.ptyId === priorPtyId) {
    tab.ptyId = replacementPtyId
  }
  const layout = session.terminalLayoutsByTabId[HOT_TAB_ID]
  if (layout?.ptyIdsByLeafId?.[HOT_LEAF_ID] === priorPtyId) {
    layout.ptyIdsByLeafId[HOT_LEAF_ID] = replacementPtyId
  }
  session.remoteSessionIdsByTabId = { [HOT_TAB_ID]: replacementPtyId }
  session.terminalPtyIncarnationsByPaneKey![HOT_PANE_KEY] = 'post-stop-replacement-incarnation'
}
