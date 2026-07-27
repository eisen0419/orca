import { join } from 'node:path'
import { vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/types'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeIdleReclaimInternals } from './idle-empty-terminal-reclaim-hot-only-fixture'

const REPO_ID = 'idle-empty-terminal-reclaim-fixture'
export const WORKSPACE_DIR = join(process.cwd(), 'idle-empty-terminal-reclaim-fixture')

export const WORKTREE_ID = `${REPO_ID}::${WORKSPACE_DIR}`
export const HOT_TAB_ID = '55555555-5555-4555-8555-555555555555'
export const HOT_LEAF_ID = '66666666-6666-4666-8666-666666666666'
export const HOT_PANE_KEY = `${HOT_TAB_ID}:${HOT_LEAF_ID}`
export const HOT_PTY_ID = 'pty-hot'
export const HOT_INCARNATION_ID = 'hot-incarnation'
export const SECOND_TAB_ID = '77777777-7777-4777-8777-777777777777'
export const SECOND_LEAF_ID = '88888888-8888-4888-8888-888888888888'
export const SECOND_PTY_ID = 'pty-second'
export const SECOND_INCARNATION_ID = 'second-incarnation'

export type ReclaimGraphBinding = {
  tabId: string
  leafId: string
  ptyId: string
  tabPtyId?: string | null
  layoutPtyId?: string
}

let reclaimGraphSnapshotVersion = 0

export type ReclaimFixtureStore = Record<string, unknown> & {
  createTerminalArchiveStore: (...args: never[]) => unknown
}

export function makeStore(session: WorkspaceSessionState): ReclaimFixtureStore {
  const worktreeMeta = {
    displayName: 'Fixture workspace',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
  const repo = {
    id: REPO_ID,
    path: WORKSPACE_DIR,
    displayName: 'Fixture workspace',
    badgeColor: 'blue',
    addedAt: 0,
    kind: 'folder' as const
  }
  return {
    getSettings: () => ({
      workspaceDir: WORKSPACE_DIR,
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: '',
      branchPrefixCustom: '',
      terminalIdleEmptyReclaimEnabled: true,
      terminalIdleEmptyReclaimMs: 5 * 60 * 1000
    }),
    getWorkspaceSession: () => session,
    getRepo: (repoId: string) => (repoId === REPO_ID ? repo : undefined),
    getRepos: () => [repo],
    getAllWorktreeMeta: () => ({ [WORKTREE_ID]: worktreeMeta }),
    getWorktreeMeta: (worktreeId: string) =>
      worktreeId === WORKTREE_ID ? worktreeMeta : undefined,
    setWorktreeMeta: (_worktreeId: string, updates: Record<string, unknown>) => ({
      ...worktreeMeta,
      ...updates
    }),
    setWorkspaceSession: vi.fn(),
    flushOrThrow: vi.fn(),
    createTerminalArchiveStore: vi.fn()
  }
}

function makeTerminalSnapshot(
  bindings: readonly ReclaimGraphBinding[],
  snapshotVersion = 1,
  publicationEpoch = 'headless:fixture'
): RuntimeMobileSessionTabsSnapshot {
  const activeBinding = bindings[0]!
  return {
    worktree: WORKTREE_ID,
    publicationEpoch,
    snapshotVersion,
    activeGroupId: null,
    activeTabId: activeBinding.tabId,
    activeTabType: 'terminal',
    tabs: bindings.map((binding, index) => {
      const tabPtyId = binding.tabPtyId === undefined ? binding.ptyId : binding.tabPtyId
      const layoutPtyId = binding.layoutPtyId === undefined ? binding.ptyId : binding.layoutPtyId
      return {
        type: 'terminal',
        id: `${binding.tabId}::${binding.leafId}`,
        parentTabId: binding.tabId,
        leafId: binding.leafId,
        ptyId: tabPtyId,
        title: 'Background shell',
        isActive: index === 0,
        parentLayout: {
          root: { type: 'leaf', leafId: binding.leafId },
          activeLeafId: binding.leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [binding.leafId]: layoutPtyId }
        }
      }
    })
  }
}

export function makeHotSnapshot(): RuntimeMobileSessionTabsSnapshot {
  return makeTerminalSnapshot([{ tabId: HOT_TAB_ID, leafId: HOT_LEAF_ID, ptyId: HOT_PTY_ID }])
}

export function syncReclaimGraph(
  runtime: OrcaRuntimeService,
  args: {
    tabs: readonly ReclaimGraphBinding[]
    leaves: readonly ReclaimGraphBinding[]
    mobile: ReclaimGraphBinding | readonly ReclaimGraphBinding[] | null
    publicationEpoch?: string
  }
): void {
  const mobileBindings =
    args.mobile === null ? [] : Array.isArray(args.mobile) ? args.mobile : [args.mobile]
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: args.tabs.map((binding) => ({
      tabId: binding.tabId,
      worktreeId: WORKTREE_ID,
      title: 'Background shell',
      activeLeafId: binding.leafId,
      layout: null,
      rendererVisibility: 'hidden' as const,
      creationOrigin: 'cli' as const
    })),
    leaves: args.leaves.map((binding, index) => ({
      tabId: binding.tabId,
      worktreeId: WORKTREE_ID,
      leafId: binding.leafId,
      paneRuntimeId: index + 1,
      ptyId: binding.ptyId
    })),
    mobileSessionTabs:
      mobileBindings.length > 0
        ? [
            makeTerminalSnapshot(
              mobileBindings,
              ++reclaimGraphSnapshotVersion,
              args.publicationEpoch
            )
          ]
        : []
  })
}

function startReclaimPty(
  runtime: OrcaRuntimeService,
  binding: ReclaimGraphBinding,
  incarnationId: string
): void {
  runtime.onPtySpawned(binding.ptyId, incarnationId, { awaitsRegistration: false })
  runtime.registerPty(binding.ptyId, WORKTREE_ID, null, {
    tabId: binding.tabId,
    leafId: binding.leafId,
    incarnationId
  })
  runtime.preAllocateHandleForPty(binding.ptyId)
}

type ReclaimPostStopState =
  | 'null-ambiguity'
  | 'null-ambiguity-without-leaf'
  | 'normal'
  | 'replacement'

export async function createReclaimLifecycleRuntime(postStopState: ReclaimPostStopState): Promise<{
  runtime: OrcaRuntimeService
  internals: RuntimeIdleReclaimInternals
  stopAndWait: (ptyId: string) => Promise<boolean>
  livePtyIds: Set<string>
  store: ReclaimFixtureStore
  session: WorkspaceSessionState
}> {
  const target = { tabId: HOT_TAB_ID, leafId: HOT_LEAF_ID, ptyId: HOT_PTY_ID }
  const livePtyIds = new Set<string>([target.ptyId])
  const incarnationByPtyId = new Map<string, string>([[target.ptyId, HOT_INCARNATION_ID]])
  const session = getDefaultWorkspaceSession()
  const store = makeStore(session)
  const runtime = new OrcaRuntimeService(store as never, undefined, {
    getAgentStatusSnapshot: () => []
  })
  const internals = runtime as unknown as RuntimeIdleReclaimInternals
  const stopAndWait = vi.fn(async (ptyId: string) => {
    livePtyIds.delete(ptyId)
    runtime.onPtyExit(ptyId, -1, incarnationByPtyId.get(ptyId))
    if (ptyId !== target.ptyId || postStopState === 'normal') {
      return true
    }
    if (postStopState === 'replacement') {
      const replacementRuntime = runtime as unknown as {
        adoptControllerTerminalHandle: (id: string, handle: string, incarnationId: string) => void
      }
      replacementRuntime.adoptControllerTerminalHandle(
        ptyId,
        'term_reclaim_replacement',
        'replacement-incarnation'
      )
      runtime.onPtySpawned(ptyId, 'replacement-incarnation', { awaitsRegistration: false })
      syncReclaimGraph(runtime, { tabs: [target], leaves: [], mobile: target })
      return true
    }
    syncReclaimGraph(runtime, { tabs: [target], leaves: [], mobile: target })
    for (let index = 0; index <= 128; index += 1) {
      const descendantId = `pty-reclaim-descendant-${index}`
      runtime.onPtySpawned(descendantId, `descendant-${index}`, { awaitsRegistration: false })
      runtime.registerPty(descendantId, WORKTREE_ID)
      runtime.onPtyExit(descendantId, 0)
    }
    if (postStopState === 'null-ambiguity-without-leaf') {
      runtime.registerPty(ptyId, WORKTREE_ID, null, {
        tabId: target.tabId,
        leafId: target.leafId
      })
      syncReclaimGraph(runtime, { tabs: [target], leaves: [], mobile: target })
      return true
    }
    syncReclaimGraph(runtime, { tabs: [target], leaves: [target], mobile: target })
    return true
  })
  runtime.setPtyController({
    spawn: vi.fn(),
    write: vi.fn(() => true),
    kill: vi.fn(() => true),
    stopAndWait,
    hasPty: (ptyId) => livePtyIds.has(ptyId),
    getForegroundProcess: vi.fn(async () => 'zsh'),
    inspectProcess: vi.fn(async () => ({ foregroundProcess: 'zsh', hasChildProcesses: false }))
  })
  syncReclaimGraph(runtime, { tabs: [target], leaves: [target], mobile: target })
  startReclaimPty(runtime, target, HOT_INCARNATION_ID)
  syncReclaimGraph(runtime, { tabs: [], leaves: [], mobile: target })
  runtime.setOrchestrationDb({
    getActiveCoordinatorRun: () => undefined,
    getActiveDispatchAssignees: () => [],
    getActiveDispatchForTerminal: () => undefined
  } as never)
  vi.setSystemTime(Date.now() + 6 * 60 * 1000)
  await internals.tickIdleEmptyTerminalReclaim()
  return { runtime, internals, stopAndWait, livePtyIds, store, session }
}

export function prepareSecondHotOnlyLifecycle(
  runtime: OrcaRuntimeService,
  livePtyIds: Set<string>,
  mobile: readonly ReclaimGraphBinding[] = []
): void {
  const second = { tabId: SECOND_TAB_ID, leafId: SECOND_LEAF_ID, ptyId: SECOND_PTY_ID }
  livePtyIds.add(second.ptyId)
  syncReclaimGraph(runtime, { tabs: [second], leaves: [second], mobile: [...mobile, second] })
  startReclaimPty(runtime, second, SECOND_INCARNATION_ID)
  syncReclaimGraph(runtime, { tabs: [], leaves: [], mobile: [...mobile, second] })
  vi.setSystemTime(Date.now() + 6 * 60 * 1000)
}

export function pruneNaturallyExitedPtyRecords(runtime: OrcaRuntimeService): void {
  for (let index = 0; index <= 128; index += 1) {
    const ptyId = `pty-reclaim-natural-prune-${index}`
    runtime.onPtySpawned(ptyId, `natural-prune-${index}`, { awaitsRegistration: false })
    runtime.registerPty(ptyId, WORKTREE_ID)
    runtime.onPtyExit(ptyId, 0)
  }
}

export function resetReclaimLifecycleFixture(): void {
  reclaimGraphSnapshotVersion = 0
}
