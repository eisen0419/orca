import { vi } from 'vitest'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import type { RuntimeIdleReclaimInternals } from './idle-empty-terminal-reclaim-hot-only-fixture'
import {
  HOT_INCARNATION_ID,
  HOT_LEAF_ID,
  HOT_PANE_KEY,
  HOT_PTY_ID,
  HOT_TAB_ID,
  SECOND_LEAF_ID,
  SECOND_PTY_ID,
  SECOND_TAB_ID,
  WORKSPACE_DIR,
  WORKTREE_ID,
  createReclaimLifecycleRuntime,
  prepareSecondHotOnlyLifecycle,
  pruneNaturallyExitedPtyRecords,
  syncReclaimGraph,
  type ReclaimGraphBinding
} from './idle-empty-terminal-reclaim-lifecycle-fixture'
import type { OrcaRuntimeService } from './orca-runtime'

export type ReclaimTransactionCarrierHarness = {
  runtime: OrcaRuntimeService
  internals: RuntimeIdleReclaimInternals
  stopAndWait: (ptyId: string) => Promise<boolean>
  releaseCarrier: () => Promise<void>
}

async function flushQueuedLifecycleWork(): Promise<void> {
  for (let index = 0; index < 32; index += 1) {
    await Promise.resolve()
  }
}

function clearLatchedTargetForTransactionCarrier(
  runtime: OrcaRuntimeService,
  livePtyIds: Set<string>
): ReclaimGraphBinding {
  const second = { tabId: SECOND_TAB_ID, leafId: SECOND_LEAF_ID, ptyId: SECOND_PTY_ID }
  prepareSecondHotOnlyLifecycle(runtime, livePtyIds)
  runtime.onPtyExit(HOT_PTY_ID, 0)
  pruneNaturallyExitedPtyRecords(runtime)
  syncReclaimGraph(runtime, { tabs: [], leaves: [], mobile: second })
  return second
}

export async function createArchiveTransactionCarrierHarness(): Promise<ReclaimTransactionCarrierHarness> {
  const { runtime, internals, stopAndWait, livePtyIds, store, session } =
    await createReclaimLifecycleRuntime('null-ambiguity')
  const target = { tabId: HOT_TAB_ID, leafId: HOT_LEAF_ID, ptyId: HOT_PTY_ID }
  session.tabsByWorktree[WORKTREE_ID] = [
    {
      id: HOT_TAB_ID,
      ptyId: HOT_PTY_ID,
      worktreeId: WORKTREE_ID,
      title: 'Background shell',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
  ]
  session.terminalLayoutsByTabId[HOT_TAB_ID] = {
    root: { type: 'leaf', leafId: HOT_LEAF_ID },
    activeLeafId: HOT_LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [HOT_LEAF_ID]: HOT_PTY_ID }
  }
  session.terminalPtyIncarnationsByPaneKey = { [HOT_PANE_KEY]: HOT_INCARNATION_ID }
  let finishArchive!: (archive: { id: string }) => void
  const archivePending = new Promise<{ id: string }>((resolve) => {
    finishArchive = resolve
  })
  const archiveTerminalTab = vi.fn(() => archivePending)
  store.createTerminalArchiveStore = vi.fn(() => ({
    archiveTerminalTab,
    dispose: vi.fn()
  })) as never
  const close = runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, HOT_TAB_ID)
  await flushQueuedLifecycleWork()
  if (archiveTerminalTab.mock.calls.length !== 1) {
    throw new Error('expected_archive_transaction')
  }
  const archivedTabs = session.tabsByWorktree[WORKTREE_ID]
  session.tabsByWorktree[WORKTREE_ID] = []
  const second = clearLatchedTargetForTransactionCarrier(runtime, livePtyIds)
  // Why: a renderer publication is needed to prune the headless snapshot while archive is pending.
  syncReclaimGraph(runtime, {
    tabs: [],
    leaves: [],
    mobile: [target, second],
    publicationEpoch: 'renderer:fixture'
  })
  syncReclaimGraph(runtime, {
    tabs: [],
    leaves: [],
    mobile: second,
    publicationEpoch: 'renderer:fixture'
  })
  return {
    runtime,
    internals,
    stopAndWait,
    releaseCarrier: async () => {
      session.tabsByWorktree[WORKTREE_ID] = archivedTabs
      finishArchive({ id: 'archive-1' })
      await close
      session.tabsByWorktree[WORKTREE_ID] = []
      delete session.terminalLayoutsByTabId[HOT_TAB_ID]
      delete session.terminalPtyIncarnationsByPaneKey?.[HOT_PANE_KEY]
      syncReclaimGraph(runtime, { tabs: [], leaves: [], mobile: second })
    }
  }
}

export async function createSleepTransactionCarrierHarness(): Promise<ReclaimTransactionCarrierHarness> {
  const { runtime, internals, stopAndWait, livePtyIds } =
    await createReclaimLifecycleRuntime('null-ambiguity')
  let finishSleepStop!: (stopped: boolean) => void
  const sleepStopPending = new Promise<boolean>((resolve) => {
    finishSleepStop = resolve
  })
  const sleepStopAndWait = vi.fn(async (ptyId: string) => {
    if (ptyId === HOT_PTY_ID) {
      return await sleepStopPending
    }
    return await stopAndWait(ptyId)
  })
  runtime.setPtyController({
    write: vi.fn(() => true),
    kill: vi.fn(() => true),
    stopAndWait: sleepStopAndWait,
    hasPty: (ptyId) => livePtyIds.has(ptyId),
    getForegroundProcess: vi.fn(async () => 'zsh'),
    inspectProcess: vi.fn(async () => ({ foregroundProcess: 'zsh', hasChildProcesses: false })),
    listProcesses: vi
      .fn()
      .mockResolvedValueOnce([{ id: HOT_PTY_ID, cwd: WORKSPACE_DIR, title: 'Background shell' }])
      .mockResolvedValueOnce([])
  })
  const sleep = runtime.sleepTerminalsForWorktree(`id:${WORKTREE_ID}`)
  await flushQueuedLifecycleWork()
  if (sleepStopAndWait.mock.calls.length !== 1) {
    throw new Error('expected_sleep_transaction')
  }
  const second = clearLatchedTargetForTransactionCarrier(runtime, livePtyIds)
  return {
    runtime,
    internals,
    stopAndWait,
    releaseCarrier: async () => {
      finishSleepStop(true)
      await sleep
      const releaseWake = await runtime.acquireWorktreeTerminalSpawn(WORKTREE_ID)
      releaseWake()
      await flushQueuedLifecycleWork()
      syncReclaimGraph(runtime, { tabs: [], leaves: [], mobile: second })
    }
  }
}

export async function createMutationTransactionCarrierHarness(): Promise<ReclaimTransactionCarrierHarness> {
  const { runtime, internals, stopAndWait, livePtyIds } =
    await createReclaimLifecycleRuntime('null-ambiguity')
  const releaseMutation = await runtime.acquireWorktreeTerminalSpawn(WORKTREE_ID)
  const second = clearLatchedTargetForTransactionCarrier(runtime, livePtyIds)
  return {
    runtime,
    internals,
    stopAndWait,
    releaseCarrier: async () => {
      releaseMutation()
      await flushQueuedLifecycleWork()
      syncReclaimGraph(runtime, { tabs: [], leaves: [], mobile: second })
    }
  }
}

export async function createSleepStateTransactionCarrierHarness(): Promise<ReclaimTransactionCarrierHarness> {
  const { runtime, internals, stopAndWait, livePtyIds } =
    await createReclaimLifecycleRuntime('null-ambiguity')
  runtime.setPtyController({
    write: vi.fn(() => true),
    kill: vi.fn(() => true),
    stopAndWait: async (ptyId) => (ptyId === HOT_PTY_ID ? true : await stopAndWait(ptyId)),
    hasPty: (ptyId) => livePtyIds.has(ptyId),
    getForegroundProcess: vi.fn(async () => 'zsh'),
    inspectProcess: vi.fn(async () => ({ foregroundProcess: 'zsh', hasChildProcesses: false })),
    listProcesses: vi
      .fn()
      .mockResolvedValueOnce([{ id: HOT_PTY_ID, cwd: WORKSPACE_DIR, title: 'Background shell' }])
      .mockResolvedValueOnce([])
  })
  await runtime.sleepTerminalsForWorktree(`id:${WORKTREE_ID}`)
  const second = clearLatchedTargetForTransactionCarrier(runtime, livePtyIds)
  return {
    runtime,
    internals,
    stopAndWait,
    releaseCarrier: async () => {
      const releaseWake = await runtime.acquireWorktreeTerminalSpawn(WORKTREE_ID)
      releaseWake()
      await flushQueuedLifecycleWork()
      syncReclaimGraph(runtime, { tabs: [], leaves: [], mobile: second })
    }
  }
}

export async function createPaneRecoveryTransactionCarrierHarness(): Promise<ReclaimTransactionCarrierHarness> {
  const { runtime, internals, stopAndWait, livePtyIds, store } =
    await createReclaimLifecycleRuntime('null-ambiguity')
  const recoveryStore = store as typeof store & { getSshRemotePtyLeases: () => unknown[] }
  recoveryStore.getSshRemotePtyLeases = () => [
    {
      targetId: 'fixture-ssh-target',
      ptyId: HOT_PTY_ID,
      worktreeId: WORKTREE_ID,
      tabId: HOT_TAB_ID,
      leafId: HOT_LEAF_ID,
      state: 'expired',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  ]
  runtime.onPtyExit(HOT_PTY_ID, 0)
  const expectedHandle = runtime.resolveTerminalPane(HOT_PANE_KEY, WORKTREE_ID).handle
  let finishRecovery!: (terminal: RuntimeTerminalCreate) => void
  const recoveryPending = new Promise<RuntimeTerminalCreate>((resolve) => {
    finishRecovery = resolve
  })
  const createTerminal = vi.spyOn(runtime, 'createTerminal').mockReturnValue(recoveryPending)
  const recovery = runtime.recoverTerminalPane(HOT_PANE_KEY, WORKTREE_ID, expectedHandle)
  await flushQueuedLifecycleWork()
  if (createTerminal.mock.calls.length !== 1) {
    throw new Error('expected_pane_recovery_transaction')
  }
  const second = clearLatchedTargetForTransactionCarrier(runtime, livePtyIds)
  return {
    runtime,
    internals,
    stopAndWait,
    releaseCarrier: async () => {
      finishRecovery({
        handle: 'term-recovery-complete',
        tabId: HOT_TAB_ID,
        paneKey: HOT_PANE_KEY,
        ptyId: 'pty-recovery-complete',
        worktreeId: WORKTREE_ID,
        title: null,
        surface: 'background'
      })
      await recovery
      syncReclaimGraph(runtime, { tabs: [], leaves: [], mobile: second })
    }
  }
}
