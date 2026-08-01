import type { Mock } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/types'
import type {
  IdleEmptyTerminalReclaimCandidate,
  IdleEmptyTerminalReclaimCloseMode
} from './idle-empty-terminal-reclaim'
import {
  WORKTREE_ID,
  type ReclaimFixtureStore
} from './idle-empty-terminal-reclaim-lifecycle-fixture'
import type { RuntimeIdleReclaimInternals } from './idle-empty-terminal-reclaim-hot-only-fixture'
import type { OrcaRuntimeService } from './orca-runtime'

export type PersistedMatrixMode = IdleEmptyTerminalReclaimCloseMode
export type PersistedMatrixPostStop =
  | 'same-connected'
  | 'same-disconnected'
  | 'absent'
  | 'present-null'
  | 'replacement'
export type PersistedMatrixBehavior = {
  stopResult?: boolean
  throwOnStop?: boolean
  postStop?: PersistedMatrixPostStop
  replacementPtyId?: string
  flushFailure?: boolean
}

export type PersistedMatrixInternals = RuntimeIdleReclaimInternals & {
  graphStatus: 'unavailable' | 'reloading' | 'ready'
  idleTerminalReclaimReservationOrLatch: unknown
  leavesByPtyId: Map<string, unknown[]>
  handleByLeafKey: Map<string, string>
  waitersByHandle: Map<string, Set<unknown>>
  detachedPreAllocatedLeaves: Map<string, unknown>
  headlessTerminals: Map<string, unknown>
  headlessHydrationState: Map<string, 'pending' | 'done'>
  headlessTerminalArchiveByOperationId: Map<string, Promise<string>>
  terminalSleepByWorktreeId: Map<string, Promise<unknown>>
  terminalMutationTailByWorktreeId: Map<string, Promise<void>>
  terminalSleepStateByWorktreeId: Map<string, unknown>
  terminalPaneRecoveryByIdentity: Map<string, Promise<unknown>>
  controllerTerminalIdentityByPtyId: Map<string, unknown>
  releaseIdleTerminalReclaimAmbiguityLatchWhenNaturallyCleared: () => void
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

export type PersistedMatrixHarness = {
  runtime: OrcaRuntimeService
  internals: PersistedMatrixInternals
  store: ReclaimFixtureStore & {
    getWorkspaceSession: () => WorkspaceSessionState
    setWorkspaceSession: Mock
    restoreWorkspaceSessionAfterFailedFlush: Mock
    flushOrThrow: Mock
  }
  stopAndWait: Mock
  session: WorkspaceSessionState
  getSession: () => WorkspaceSessionState
  candidate: IdleEmptyTerminalReclaimCandidate
  behavior: PersistedMatrixBehavior
  idleTerminalReclaimReservationOrLatch: unknown
  addCandidate: (args: {
    mode: PersistedMatrixMode
    ptyId: string
    tabId: string
    leafId: string
    incarnationId: string
    behavior?: PersistedMatrixBehavior
  }) => IdleEmptyTerminalReclaimCandidate
  refreshGraph: () => void
  setProviderState: (state: boolean | null | undefined) => void
  setBehavior: (behavior: PersistedMatrixBehavior) => void
  dispose: () => void
}

export function basePersistedMatrixCandidate(
  mode: PersistedMatrixMode,
  ptyId: string,
  tabId: string,
  leafId: string,
  incarnationId: string
): IdleEmptyTerminalReclaimCandidate {
  return {
    tabId,
    leafId,
    ptyId,
    worktreeId: WORKTREE_ID,
    incarnationId,
    expectedIncarnationId: incarnationId,
    activityGeneration: 0,
    expectedActivityGeneration: 0,
    isSinglePane: true,
    hasExactTabLeafPtyWorktreeBinding: true,
    hasSharedPty: false,
    isPersisted: mode !== 'hot-only',
    rendererOwnsPersistedTab: mode === 'renderer-owned-persisted',
    authoritativePersistedOwner:
      mode === 'hot-only'
        ? null
        : mode === 'renderer-owned-persisted'
          ? { kind: 'renderer', source: 'ready-exact-renderer-binding' }
          : { kind: 'runtime', source: 'serve-or-ssh-pty-id' },
    origin: 'cli',
    used: false,
    isPinned: false,
    isSleepingOrHibernating: false,
    hasPendingRestoreOrReconnect: false,
    hasStartupCommand: false,
    hasLaunchConfig: false,
    hasResumeProviderSession: false,
    hasLaunchAgent: false,
    hasForegroundAgent: false,
    agentStatus: 'none',
    hasProviderSession: false,
    hasOrchestrationOwnership: false,
    lastActivityAt: 0,
    providerConnected: true,
    providerWritable: true,
    inspection: { status: 'success', foregroundProcess: 'shell', hasChildProcesses: false },
    rendererVisibility: 'hidden',
    hasMobileDriver: false,
    hasMobileSubscriber: false,
    hasRemoteDesktopViewer: false,
    isActiveCoordinatorHandle: false,
    hasPendingOrDispatchedContext: false,
    hasInFlightTransaction: false,
    hasSecondConfirmation: true,
    hasExactIdentityClaim: true
  }
}

export function bindPersistedMatrixSession(
  session: WorkspaceSessionState,
  ptyId: string,
  tabId: string,
  leafId: string,
  incarnationId: string
): void {
  session.tabsByWorktree[WORKTREE_ID] = [
    ...(session.tabsByWorktree[WORKTREE_ID] ?? []).filter((tab) => tab.id !== tabId),
    {
      id: tabId,
      ptyId,
      worktreeId: WORKTREE_ID,
      title: 'Background shell',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0,
      creationOrigin: 'cli'
    }
  ]
  session.terminalLayoutsByTabId[tabId] = {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
  session.terminalPtyIncarnationsByPaneKey = {
    ...session.terminalPtyIncarnationsByPaneKey,
    [`${tabId}:${leafId}`]: incarnationId
  }
}

export function makePersistedMatrixRecord(
  internals: PersistedMatrixInternals,
  ptyId: string,
  tabId: string,
  leafId: string,
  incarnationId: string
): void {
  const record = internals.recordPtyWorktree(ptyId, WORKTREE_ID, {
    connected: true,
    incarnationId,
    tabId,
    paneKey: `${tabId}:${leafId}`
  })
  record.creationOrigin = 'cli'
  record.lastActivityAt = 0
  internals.launchFactsAuthoritativeIncarnationByPtyId.set(ptyId, incarnationId)
}
