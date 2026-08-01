import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HOT_LEAF_ID,
  HOT_PANE_KEY,
  HOT_TAB_ID,
  SECOND_LEAF_ID,
  SECOND_TAB_ID,
  WORKTREE_ID
} from './idle-empty-terminal-reclaim-lifecycle-fixture'
import type {
  PersistedMatrixHarness,
  PersistedMatrixMode
} from './idle-empty-terminal-reclaim-persisted-matrix-fixture'
import { createPersistedMatrixRuntime } from './idle-empty-terminal-reclaim-persisted-matrix-runtime'

const modes: readonly PersistedMatrixMode[] = [
  'renderer-owned-persisted',
  'runtime-owned-persisted'
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

function clearTarget(harness: PersistedMatrixHarness): void {
  const session = harness.getSession()
  session.tabsByWorktree[WORKTREE_ID] = []
  delete session.terminalLayoutsByTabId[HOT_TAB_ID]
  delete session.remoteSessionIdsByTabId?.[HOT_TAB_ID]
  delete session.terminalPtyIncarnationsByPaneKey?.[HOT_PANE_KEY]
}

function wrapStop(harness: PersistedMatrixHarness, afterStop: () => void): void {
  const original = harness.stopAndWait.getMockImplementation()
  if (!original) {
    throw new Error('missing_stop_implementation')
  }
  harness.stopAndWait.mockImplementation(async (ptyId: string) => {
    const result = await original(ptyId)
    afterStop()
    return result
  })
}

describe.each(modes)('persisted retirement receipt matrix: $mode', (mode) => {
  it('accepts an already-retired exact surface only with a newer topology revision', async () => {
    const harness = createPersistedMatrixRuntime({ mode })
    harness.getSession().terminalTopologyRevisionByRepoId = { [WORKTREE_ID.split('::')[0]!]: 0 }
    wrapStop(harness, () => {
      clearTarget(harness)
      harness.getSession().terminalTopologyRevisionByRepoId = {
        [WORKTREE_ID.split('::')[0]!]: 1
      }
    })
    await expect(reclaim(harness)).resolves.toMatchObject({ reclaimed: true })
    expect(harness.store.flushOrThrow).not.toHaveBeenCalled()
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(harness.internals.idleTerminalReclaimReservationOrLatch).toBeNull()
    harness.dispose()
  })

  it.each([
    { name: 'missing session setter', remove: 'setWorkspaceSession' as const },
    { name: 'flush throws', behavior: { flushFailure: true } },
    { name: 'write/readback disagrees', readback: true }
  ])(
    '$name retains public state and blocks the next candidate',
    async ({ remove, behavior, readback }) => {
      const harness = createPersistedMatrixRuntime({ mode, behavior })
      if (remove) {
        Reflect.deleteProperty(harness.store, remove)
      }
      if (readback) {
        harness.store.setWorkspaceSession.mockImplementation(() => undefined)
      }
      const before = structuredClone(harness.getSession())
      const mobileBefore = structuredClone(harness.internals.mobileSessionTabsByWorktree)
      await reclaim(harness)
      expect(harness.getSession()).toEqual(before)
      expect(harness.internals.mobileSessionTabsByWorktree).toEqual(mobileBefore)
      expect(harness.internals.idleTerminalReclaimReservationOrLatch).toMatchObject({
        kind: 'ambiguity-latch'
      })
      const second = harness.addCandidate({
        mode,
        ptyId: mode === 'runtime-owned-persisted' ? 'serve-receipt-second' : 'receipt-second-pty',
        tabId: '77777777-7777-4777-8777-777777777777',
        leafId: '88888888-8888-4888-8888-888888888888',
        incarnationId: 'receipt-second-incarnation'
      })
      await reclaimCandidate(harness, second)
      expect(harness.stopAndWait).toHaveBeenCalledOnce()
      harness.dispose()
    }
  )

  it('flushes before publishing mobile absence', async () => {
    const harness = createPersistedMatrixRuntime({ mode })
    const events: string[] = []
    const originalFlush = harness.store.flushOrThrow.getMockImplementation()
    harness.store.flushOrThrow.mockImplementation(() => {
      events.push('flushOrThrow')
      originalFlush?.()
    })
    harness.runtime.onMobileSessionTabsChanged(() => events.push('mobile-absence'))
    await expect(reclaim(harness)).resolves.toMatchObject({ reclaimed: true })
    expect(events).toEqual(['flushOrThrow', 'mobile-absence'])
    harness.dispose()
  })

  it('different non-null replacement preserves provider, workspace, mobile, handle, and headless state', async () => {
    const harness = createPersistedMatrixRuntime({
      mode,
      behavior: { postStop: 'replacement', replacementPtyId: 'replacement-pty' }
    })
    const targetPty = harness.candidate.ptyId!
    const handle = harness.internals.handleByPtyId.get(targetPty)
    const headless = { marker: 'headless-state' }
    harness.internals.headlessTerminals.set(targetPty, headless)
    harness.internals.headlessHydrationState.set(targetPty, 'done')
    await reclaim(harness)
    expect(harness.stopAndWait).toHaveBeenCalledOnce()
    expect(harness.store.flushOrThrow).not.toHaveBeenCalled()
    expect(harness.internals.ptysById.get(targetPty)).toMatchObject({
      connected: true,
      incarnationId: 'replacement-pty-incarnation'
    })
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]?.[0]?.ptyId).toBe('replacement-pty')
    expect(harness.internals.mobileSessionTabsByWorktree.get(WORKTREE_ID)?.tabs).toHaveLength(1)
    expect(harness.internals.handleByPtyId.get(targetPty)).toBe(handle)
    expect(harness.internals.headlessTerminals.get(targetPty)).toBe(headless)
    expect(harness.internals.headlessHydrationState.get(targetPty)).toBe('done')
    harness.dispose()
  })

  it('ambiguous stop leaves session, mobile, graph, handles, detached, headless, and record untouched', async () => {
    const harness = createPersistedMatrixRuntime({ mode, behavior: { throwOnStop: true } })
    const targetPty = harness.candidate.ptyId!
    const targetHandle = harness.internals.handleByPtyId.get(targetPty)
    expect(targetHandle).toBeDefined()
    harness.internals.waitersByHandle.set(targetHandle!, new Set([{}]))
    harness.internals.detachedPreAllocatedLeaves.set(targetPty, { ptyId: targetPty })
    harness.internals.headlessTerminals.set(targetPty, { ptyId: targetPty })
    const before = {
      session: structuredClone(harness.getSession()),
      mobile: structuredClone(harness.internals.mobileSessionTabsByWorktree),
      tabs: structuredClone(harness.internals.tabs),
      leaves: structuredClone(harness.internals.leaves),
      handles: structuredClone(harness.internals.handles),
      waiters: structuredClone(harness.internals.waitersByHandle),
      detached: structuredClone(harness.internals.detachedPreAllocatedLeaves),
      headless: structuredClone(harness.internals.headlessTerminals),
      record: structuredClone(harness.internals.ptysById.get(targetPty))
    }
    await reclaim(harness)
    expect(harness.getSession()).toEqual(before.session)
    expect(harness.internals.mobileSessionTabsByWorktree).toEqual(before.mobile)
    expect(harness.internals.tabs).toEqual(before.tabs)
    expect(harness.internals.leaves).toEqual(before.leaves)
    expect(harness.internals.handles).toEqual(before.handles)
    expect(harness.internals.waitersByHandle).toEqual(before.waiters)
    expect(harness.internals.detachedPreAllocatedLeaves).toEqual(before.detached)
    expect(harness.internals.headlessTerminals).toEqual(before.headless)
    expect(harness.internals.ptysById.get(targetPty)).toEqual(before.record)
    harness.dispose()
  })

  it('exact retirement preserves a same-leaf replacement incarnation', async () => {
    const harness = createPersistedMatrixRuntime({
      mode,
      behavior: { postStop: 'same-disconnected' }
    })
    const targetPty = harness.candidate.ptyId!
    const replacementIncarnation = 'same-leaf-replacement-incarnation'
    wrapStop(harness, () => {
      const session = harness.getSession()
      session.terminalPtyIncarnationsByPaneKey = {
        ...session.terminalPtyIncarnationsByPaneKey,
        [HOT_PANE_KEY]: replacementIncarnation
      }
    })

    await expect(reclaim(harness)).resolves.toMatchObject({ reclaimed: false })
    expect(harness.stopAndWait).toHaveBeenCalledOnce()
    expect(harness.store.flushOrThrow).not.toHaveBeenCalled()
    const session = harness.getSession()
    expect(session.terminalPtyIncarnationsByPaneKey?.[HOT_PANE_KEY]).toBe(replacementIncarnation)
    expect(session.terminalLayoutsByTabId[HOT_TAB_ID]?.ptyIdsByLeafId?.[HOT_LEAF_ID]).toBe(
      targetPty
    )
    expect(session.tabsByWorktree[WORKTREE_ID]?.find((tab) => tab.id === HOT_TAB_ID)?.ptyId).toBe(
      targetPty
    )
    expect(harness.internals.idleTerminalReclaimReservationOrLatch).toBeNull()
    harness.dispose()
  })

  it('exact retirement preserves a sibling leaf and a non-exact tab', async () => {
    const harness = createPersistedMatrixRuntime({ mode })
    wrapStop(harness, () => {
      const session = harness.getSession()
      const layout = session.terminalLayoutsByTabId[HOT_TAB_ID]!
      layout.root = {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: HOT_LEAF_ID },
        second: { type: 'leaf', leafId: SECOND_LEAF_ID }
      }
      layout.ptyIdsByLeafId = {
        ...layout.ptyIdsByLeafId,
        [SECOND_LEAF_ID]: 'sibling-pty'
      }
      session.terminalPtyIncarnationsByPaneKey = {
        ...session.terminalPtyIncarnationsByPaneKey,
        [`${HOT_TAB_ID}:${SECOND_LEAF_ID}`]: 'sibling-incarnation'
      }
      session.tabsByWorktree[WORKTREE_ID]!.push({
        id: SECOND_TAB_ID,
        ptyId: 'non-exact-pty',
        worktreeId: WORKTREE_ID,
        title: 'Other shell',
        customTitle: null,
        color: null,
        sortOrder: 1,
        createdAt: 0,
        creationOrigin: 'cli'
      })
    })
    const result = await reclaim(harness)
    expect(result).toMatchObject({ reclaimed: false })
    expect(harness.store.flushOrThrow).toHaveBeenCalledOnce()
    const session = harness.getSession()
    expect(session.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      HOT_TAB_ID,
      SECOND_TAB_ID
    ])
    expect(session.terminalLayoutsByTabId[HOT_TAB_ID]?.ptyIdsByLeafId?.[SECOND_LEAF_ID]).toBe(
      'sibling-pty'
    )
    expect(session.terminalPtyIncarnationsByPaneKey?.[`${HOT_TAB_ID}:${SECOND_LEAF_ID}`]).toBe(
      'sibling-incarnation'
    )
    harness.dispose()
  })
})
