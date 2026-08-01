import { vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/types'
import {
  HOT_INCARNATION_ID,
  HOT_LEAF_ID,
  HOT_PTY_ID,
  HOT_TAB_ID,
  makeStore,
  syncReclaimGraph,
  WORKTREE_ID
} from './idle-empty-terminal-reclaim-lifecycle-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import {
  basePersistedMatrixCandidate,
  bindPersistedMatrixSession,
  makePersistedMatrixRecord,
  type PersistedMatrixBehavior,
  type PersistedMatrixHarness,
  type PersistedMatrixInternals,
  type PersistedMatrixMode
} from './idle-empty-terminal-reclaim-persisted-matrix-fixture'

type MatrixEntry = {
  mode: PersistedMatrixMode
  candidate: ReturnType<typeof basePersistedMatrixCandidate>
  behavior: PersistedMatrixBehavior
}

type MatrixRecord = {
  connected: boolean
  incarnationId: string | null
  creationOrigin: 'user' | 'cli' | 'orchestration' | null
}

function synchronizeGraph(runtime: OrcaRuntimeService, entries: readonly MatrixEntry[]): void {
  const all = entries.map(({ candidate }) => ({
    tabId: candidate.tabId!,
    leafId: candidate.leafId!,
    ptyId: candidate.ptyId!
  }))
  const renderer = entries
    .filter(({ mode }) => mode === 'renderer-owned-persisted')
    .map(({ candidate }) => ({
      tabId: candidate.tabId!,
      leafId: candidate.leafId!,
      ptyId: candidate.ptyId!
    }))
  syncReclaimGraph(runtime, { tabs: renderer, leaves: renderer, mobile: all })
}

function applyStopState(
  internals: PersistedMatrixInternals,
  session: WorkspaceSessionState,
  livePtyIds: Set<string>,
  entry: MatrixEntry,
  stopped: boolean
): void {
  const candidate = entry.candidate
  const behavior = entry.behavior
  if (stopped) {
    if (behavior.postStop === 'replacement') {
      livePtyIds.add(candidate.ptyId!)
    } else {
      livePtyIds.delete(candidate.ptyId!)
    }
  }
  const record = internals.ptysById.get(candidate.ptyId!) as MatrixRecord | undefined
  if (behavior.postStop === 'absent') {
    internals.ptysById.delete(candidate.ptyId!)
    return
  }
  if (!record) {
    return
  }
  record.connected = behavior.postStop === 'same-connected'
  if (behavior.postStop === 'present-null') {
    record.incarnationId = null
  }
  if (behavior.postStop !== 'replacement') {
    return
  }
  const replacementPtyId = behavior.replacementPtyId ?? 'post-stop-replacement'
  const replacementIncarnation = `${replacementPtyId}-incarnation`
  const replacement = internals.recordPtyWorktree(candidate.ptyId!, WORKTREE_ID, {
    connected: true,
    incarnationId: replacementIncarnation,
    tabId: candidate.tabId!,
    paneKey: `${candidate.tabId}:${candidate.leafId}`
  }) as unknown as MatrixRecord
  replacement.creationOrigin = 'cli'
  internals.launchFactsAuthoritativeIncarnationByPtyId.set(candidate.ptyId!, replacementIncarnation)
  const tab = session.tabsByWorktree[WORKTREE_ID]?.find((item) => item.id === candidate.tabId)
  if (tab) {
    tab.ptyId = replacementPtyId
  }
  const layout = session.terminalLayoutsByTabId[candidate.tabId!]
  if (layout) {
    layout.ptyIdsByLeafId = {
      ...layout.ptyIdsByLeafId,
      [candidate.leafId!]: replacementPtyId
    }
  }
  session.remoteSessionIdsByTabId = {
    ...session.remoteSessionIdsByTabId,
    [candidate.tabId!]: replacementPtyId
  }
  session.terminalPtyIncarnationsByPaneKey = {
    ...session.terminalPtyIncarnationsByPaneKey,
    [`${candidate.tabId}:${candidate.leafId}`]: replacementIncarnation
  }
}

export function createPersistedMatrixRuntime(args: {
  mode: PersistedMatrixMode
  ptyId?: string
  tabId?: string
  leafId?: string
  incarnationId?: string
  behavior?: PersistedMatrixBehavior
  session?: WorkspaceSessionState
}): PersistedMatrixHarness {
  const ptyId =
    args.ptyId ?? (args.mode === 'runtime-owned-persisted' ? 'serve-persisted' : HOT_PTY_ID)
  const tabId = args.tabId ?? HOT_TAB_ID
  const leafId = args.leafId ?? HOT_LEAF_ID
  const incarnationId = args.incarnationId ?? HOT_INCARNATION_ID
  const session = args.session ?? getDefaultWorkspaceSession()
  if (args.mode !== 'hot-only') {
    bindPersistedMatrixSession(session, ptyId, tabId, leafId, incarnationId)
  }
  const fixtureStore = makeStore(session)
  let persistedSession = session
  const store = fixtureStore as PersistedMatrixHarness['store']
  store.getWorkspaceSession = () => persistedSession
  store.setWorkspaceSession = vi.fn((next: WorkspaceSessionState) => {
    persistedSession = next
  })
  store.restoreWorkspaceSessionAfterFailedFlush = vi.fn((previous: WorkspaceSessionState) => {
    persistedSession = previous
  })
  const initialBehavior: PersistedMatrixBehavior = {
    ...args.behavior,
    postStop:
      args.behavior?.postStop ??
      (args.behavior?.stopResult === false ? 'same-connected' : 'same-disconnected')
  }
  const entries: MatrixEntry[] = []
  const livePtyIds = new Set([ptyId])
  let providerState: boolean | null | undefined
  let providerStateConfigured = false
  let activeFlushFailure = false
  let internals: PersistedMatrixInternals | null = null
  const stopAndWait = vi.fn(async (stoppingPtyId: string) => {
    const entry = entries.find(({ candidate }) => candidate.ptyId === stoppingPtyId)
    if (!entry) {
      throw new Error('unknown_matrix_pty')
    }
    activeFlushFailure = entry.behavior.flushFailure === true
    if (entry.behavior.throwOnStop) {
      throw new Error('stop-failed')
    }
    applyStopState(
      internals!,
      persistedSession,
      livePtyIds,
      entry,
      entry.behavior.stopResult !== false
    )
    return entry.behavior.stopResult ?? true
  })
  const runtime = new OrcaRuntimeService(fixtureStore as never, undefined, {
    getAgentStatusSnapshot: () => []
  })
  internals = runtime as unknown as PersistedMatrixInternals
  internals.graphStatus = 'ready'
  runtime.setPtyController({
    spawn: vi.fn(),
    write: vi.fn(() => true),
    kill: vi.fn(() => true),
    stopAndWait,
    hasPty: (id) => (providerStateConfigured ? providerState! : livePtyIds.has(id)),
    getForegroundProcess: vi.fn(async () => 'zsh'),
    inspectProcess: vi.fn(async () => ({ foregroundProcess: 'zsh', hasChildProcesses: false }))
  })
  store.flushOrThrow.mockImplementation(() => {
    if (activeFlushFailure) {
      throw new Error('disk-full')
    }
  })
  runtime.setOrchestrationDb({
    getActiveCoordinatorRun: () => undefined,
    getActiveDispatchAssignees: () => [],
    getActiveDispatchForTerminal: () => undefined
  } as never)

  const addCandidate = (candidateArgs: {
    mode: PersistedMatrixMode
    ptyId: string
    tabId: string
    leafId: string
    incarnationId: string
    behavior?: PersistedMatrixBehavior
  }) => {
    if (candidateArgs.mode !== 'hot-only') {
      bindPersistedMatrixSession(
        persistedSession,
        candidateArgs.ptyId,
        candidateArgs.tabId,
        candidateArgs.leafId,
        candidateArgs.incarnationId
      )
    }
    makePersistedMatrixRecord(
      internals!,
      candidateArgs.ptyId,
      candidateArgs.tabId,
      candidateArgs.leafId,
      candidateArgs.incarnationId
    )
    runtime.preAllocateHandleForPty(candidateArgs.ptyId)
    livePtyIds.add(candidateArgs.ptyId)
    const entry: MatrixEntry = {
      mode: candidateArgs.mode,
      candidate: basePersistedMatrixCandidate(
        candidateArgs.mode,
        candidateArgs.ptyId,
        candidateArgs.tabId,
        candidateArgs.leafId,
        candidateArgs.incarnationId
      ),
      behavior: {
        ...candidateArgs.behavior,
        postStop:
          candidateArgs.behavior?.postStop ??
          (candidateArgs.behavior?.stopResult === false ? 'same-connected' : 'same-disconnected')
      }
    }
    entries.push(entry)
    synchronizeGraph(runtime, entries)
    return entry.candidate
  }

  const candidate = addCandidate({
    mode: args.mode,
    ptyId,
    tabId,
    leafId,
    incarnationId,
    behavior: initialBehavior
  })
  const behavior = entries[0]!.behavior
  const harness: PersistedMatrixHarness = {
    runtime,
    internals,
    store,
    stopAndWait,
    session,
    getSession: () => persistedSession,
    candidate,
    behavior,
    get idleTerminalReclaimReservationOrLatch() {
      return internals!.idleTerminalReclaimReservationOrLatch
    },
    setProviderState: (state) => {
      providerStateConfigured = state !== undefined
      providerState = state
    },
    setBehavior: (next) => {
      Object.assign(behavior, next)
      if (next.flushFailure === false) {
        activeFlushFailure = false
      }
    },
    addCandidate,
    refreshGraph: () => synchronizeGraph(runtime, entries),
    dispose: () => runtime.dispose()
  }
  return harness
}
