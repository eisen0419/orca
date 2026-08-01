import {
  HOT_INCARNATION_ID,
  HOT_LEAF_ID,
  HOT_PANE_KEY,
  HOT_PTY_ID,
  HOT_TAB_ID,
  makeHotLayoutOnlySnapshot,
  makeHotSnapshot,
  WORKTREE_ID
} from './idle-empty-terminal-reclaim-lifecycle-fixture'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree-id'
import type { PersistedMatrixHarness } from './idle-empty-terminal-reclaim-persisted-matrix-fixture'

export type CarrierCase = {
  name: string
  holdsLatch?: boolean
  apply: (harness: PersistedMatrixHarness) => () => void
}

function normalizedWorktreeKey(worktreeId: string): string {
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  return parsed
    ? `${parsed.repoId}\0${normalizeRuntimePathForComparison(parsed.worktreePath)}`
    : worktreeId
}

function terminalTab(ptyId: string | null) {
  return {
    id: HOT_TAB_ID,
    ptyId,
    worktreeId: WORKTREE_ID,
    title: 'Background shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    creationOrigin: 'cli' as const
  }
}

function sessionCarrier(
  harness: PersistedMatrixHarness,
  args: {
    tabPtyId?: string | null
    layoutPtyId?: string
    remotePtyId?: string
    incarnationId?: string
  }
): () => void {
  const session = harness.getSession()
  session.tabsByWorktree[WORKTREE_ID] = [terminalTab(args.tabPtyId ?? null)]
  if (args.layoutPtyId !== undefined) {
    session.terminalLayoutsByTabId[HOT_TAB_ID] = {
      root: { type: 'leaf', leafId: HOT_LEAF_ID },
      activeLeafId: HOT_LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [HOT_LEAF_ID]: args.layoutPtyId }
    }
  }
  if (args.remotePtyId !== undefined) {
    session.remoteSessionIdsByTabId = { [HOT_TAB_ID]: args.remotePtyId }
  }
  if (args.incarnationId !== undefined) {
    session.terminalPtyIncarnationsByPaneKey = { [HOT_PANE_KEY]: args.incarnationId }
  }
  return () => {
    session.tabsByWorktree[WORKTREE_ID] = []
    delete session.terminalLayoutsByTabId[HOT_TAB_ID]
    delete session.remoteSessionIdsByTabId?.[HOT_TAB_ID]
    delete session.terminalPtyIncarnationsByPaneKey?.[HOT_PANE_KEY]
  }
}

function sshLeaseCarrier(
  harness: PersistedMatrixHarness,
  state: 'attached' | 'detached'
): () => void {
  const latch = (
    harness.internals.idleTerminalReclaimReservationOrLatch as {
      latch: { ptyId: string }
    }
  ).latch
  const previousPtyId = latch.ptyId
  latch.ptyId = 'ssh:target-1@@relay-pty'
  ;(harness.store as unknown as { getSshRemotePtyLeases: () => unknown[] }).getSshRemotePtyLeases =
    () => [
      {
        targetId: 'target-1',
        ptyId: 'relay-pty',
        worktreeId: WORKTREE_ID,
        tabId: HOT_TAB_ID,
        leafId: HOT_LEAF_ID,
        state
      }
    ]
  return () => {
    latch.ptyId = previousPtyId
    delete (harness.store as unknown as { getSshRemotePtyLeases?: unknown }).getSshRemotePtyLeases
  }
}

export const carriers: readonly CarrierCase[] = [
  {
    name: 'mobile direct tab.ptyId',
    apply: (h) => {
      h.internals.mobileSessionTabsByWorktree.set(WORKTREE_ID, makeHotSnapshot())
      return () => h.internals.mobileSessionTabsByWorktree.clear()
    }
  },
  {
    name: 'mobile parentLayout.ptyIdsByLeafId',
    apply: (h) => {
      h.internals.mobileSessionTabsByWorktree.set(WORKTREE_ID, makeHotLayoutOnlySnapshot())
      return () => h.internals.mobileSessionTabsByWorktree.clear()
    }
  },
  {
    name: 'leaf handle',
    apply: (h) => {
      h.internals.handleByLeafKey.set(`${HOT_TAB_ID}::${HOT_LEAF_ID}`, 'leaf-handle')
      h.internals.handles.set('leaf-handle', { ptyId: HOT_PTY_ID })
      return () => h.internals.handles.clear()
    }
  },
  {
    name: 'pty alias',
    apply: (h) => {
      h.internals.handleByPtyId.set(HOT_PTY_ID, 'pty-handle')
      return () => h.internals.handleByPtyId.clear()
    }
  },
  {
    name: 'orphan handle and waiter',
    apply: (h) => {
      h.internals.handles.set('orphan-handle', { ptyId: HOT_PTY_ID })
      h.internals.waitersByHandle.set('orphan-handle', new Set([{}]))
      return () => {
        h.internals.handles.clear()
        h.internals.waitersByHandle.clear()
      }
    }
  },
  { name: 'persisted layout', apply: (h) => sessionCarrier(h, { layoutPtyId: HOT_PTY_ID }) },
  { name: 'persisted tab', apply: (h) => sessionCarrier(h, { tabPtyId: HOT_PTY_ID }) },
  {
    name: 'persisted remote session',
    apply: (h) => sessionCarrier(h, { remotePtyId: HOT_PTY_ID })
  },
  {
    name: 'persisted incarnation',
    apply: (h) => sessionCarrier(h, { incarnationId: HOT_INCARNATION_ID })
  },
  {
    name: 'renderer leaf-only',
    apply: (h) => {
      h.internals.leaves.set(`${HOT_TAB_ID}::${HOT_LEAF_ID}`, {
        tabId: HOT_TAB_ID,
        leafId: HOT_LEAF_ID,
        worktreeId: WORKTREE_ID,
        ptyId: HOT_PTY_ID
      })
      return () => h.internals.leaves.clear()
    }
  },
  {
    name: 'graph non-ready',
    apply: (h) => {
      h.internals.graphStatus = 'reloading'
      return () => {
        h.internals.graphStatus = 'ready'
      }
    }
  },
  {
    name: 'detached leaf',
    apply: (h) => {
      h.internals.detachedPreAllocatedLeaves.set(HOT_PTY_ID, {
        tabId: HOT_TAB_ID,
        leafId: HOT_LEAF_ID,
        worktreeId: WORKTREE_ID,
        ptyId: HOT_PTY_ID
      })
      return () => h.internals.detachedPreAllocatedLeaves.clear()
    }
  },
  {
    name: 'headless emulator',
    apply: (h) => {
      h.internals.headlessTerminals.set(HOT_PTY_ID, {})
      return () => h.internals.headlessTerminals.clear()
    }
  },
  {
    name: 'headless hydration',
    apply: (h) => {
      h.internals.headlessHydrationState.set(HOT_PTY_ID, 'pending')
      return () => h.internals.headlessHydrationState.clear()
    }
  },
  {
    name: 'old PTY record',
    apply: (h) => {
      h.internals.recordPtyWorktree(HOT_PTY_ID, WORKTREE_ID, {
        connected: false,
        incarnationId: HOT_INCARNATION_ID,
        tabId: HOT_TAB_ID,
        paneKey: HOT_PANE_KEY
      })
      return () => h.internals.ptysById.delete(HOT_PTY_ID)
    }
  },
  {
    name: 'provider true',
    apply: (h) => {
      h.setProviderState(true)
      return () => h.setProviderState(undefined)
    }
  },
  {
    name: 'provider null',
    apply: (h) => {
      h.setProviderState(null)
      return () => h.setProviderState(undefined)
    }
  },
  { name: 'SSH attached lease', apply: (h) => sshLeaseCarrier(h, 'attached') },
  { name: 'SSH detached lease', apply: (h) => sshLeaseCarrier(h, 'detached') },
  {
    name: 'archive transaction',
    apply: (h) => {
      h.internals.headlessTerminalArchiveByOperationId.set(
        `user-close:${HOT_TAB_ID}:fixture`,
        Promise.resolve('archive')
      )
      return () => h.internals.headlessTerminalArchiveByOperationId.clear()
    }
  },
  {
    name: 'sleep transaction',
    apply: (h) => {
      h.internals.terminalSleepByWorktreeId.set(WORKTREE_ID, Promise.resolve())
      return () => h.internals.terminalSleepByWorktreeId.clear()
    }
  },
  {
    name: 'mutation transaction',
    apply: (h) => {
      h.internals.terminalMutationTailByWorktreeId.set(
        normalizedWorktreeKey(WORKTREE_ID),
        Promise.resolve()
      )
      return () => h.internals.terminalMutationTailByWorktreeId.clear()
    }
  },
  {
    name: 'recovery transaction',
    apply: (h) => {
      h.internals.terminalPaneRecoveryByIdentity.set(
        `${WORKTREE_ID}\0${HOT_PANE_KEY}`,
        Promise.resolve()
      )
      return () => h.internals.terminalPaneRecoveryByIdentity.clear()
    }
  },
  {
    name: 'controller identity cache (reverse)',
    holdsLatch: false,
    apply: (h) => {
      h.internals.controllerTerminalIdentityByPtyId.set(HOT_PTY_ID, {
        handle: 'stale-handle',
        incarnationId: HOT_INCARNATION_ID
      })
      return () => h.internals.controllerTerminalIdentityByPtyId.clear()
    }
  },
  {
    name: 'renderer tab-only projection (reverse)',
    holdsLatch: false,
    apply: (h) => {
      h.internals.tabs.set(HOT_TAB_ID, { tabId: HOT_TAB_ID, worktreeId: WORKTREE_ID })
      return () => h.internals.tabs.clear()
    }
  }
]

export function clearBaselineResidue(harness: PersistedMatrixHarness): void {
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
  harness.internals.ptysById.delete(HOT_PTY_ID)
  harness.internals.reclaimInFlightByPtyId.clear()
  harness.internals.headlessTerminalArchiveByOperationId.clear()
  harness.internals.terminalSleepByWorktreeId.clear()
  harness.internals.terminalMutationTailByWorktreeId.clear()
  harness.internals.terminalSleepStateByWorktreeId.clear()
  harness.internals.terminalPaneRecoveryByIdentity.clear()
  harness.internals.controllerTerminalIdentityByPtyId.clear()
  harness.getSession().tabsByWorktree[WORKTREE_ID] = []
  harness.internals.graphStatus = 'ready'
  harness.setProviderState(undefined)
}
