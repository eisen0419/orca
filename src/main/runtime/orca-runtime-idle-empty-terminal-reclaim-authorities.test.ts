import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { TerminalTab, WorkspaceSessionState } from '../../shared/types'
import {
  evaluateIdleReclaimCandidate,
  type IdleEmptyTerminalReclaimCandidate
} from './idle-empty-terminal-reclaim'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE_ID = 'worktree-1'
const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const RUNTIME_TAB_ID = '33333333-3333-4333-8333-333333333333'
const RUNTIME_LEAF_ID = '44444444-4444-4444-8444-444444444444'
const RUNTIME_PANE_KEY = `${RUNTIME_TAB_ID}:${RUNTIME_LEAF_ID}`
const HOT_TAB_ID = '55555555-5555-4555-8555-555555555555'
const HOT_LEAF_ID = '66666666-6666-4666-8666-666666666666'

type RuntimeIdleReclaimInternals = {
  tickIdleEmptyTerminalReclaim: () => Promise<void>
  collectIdleEmptyTerminalReclaimCandidates: () => Promise<IdleEmptyTerminalReclaimCandidate[]>
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean; incarnationId?: string; tabId?: string; paneKey?: string }
  ) => {
    ptyId: string
    worktreeId: string
    tabId: string | null
    paneKey: string | null
    incarnationId: string | null
    creationOrigin: 'user' | 'cli' | 'orchestration' | null
    hasEverReceivedExternalInput: boolean
    activityGeneration: number
    lastActivityAt: number
  }
  tabs: Map<string, unknown>
  leaves: Map<string, unknown>
  graphStatus: 'unavailable' | 'reloading' | 'ready'
}

function makeStore(enabled: boolean, session: WorkspaceSessionState | null = null) {
  return {
    getSettings: () => ({
      workspaceDir: '/tmp',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: '',
      branchPrefixCustom: '',
      terminalIdleEmptyReclaimEnabled: enabled,
      terminalIdleEmptyReclaimMs: 5 * 60 * 1000
    }),
    getWorkspaceSession: () => session
  }
}

function persistedTerminalTab(): TerminalTab {
  return {
    id: TAB_ID,
    ptyId: 'pty-1',
    worktreeId: WORKTREE_ID,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    creationOrigin: 'cli'
  }
}

function runtimeOwnedPersistedTerminalTab(): TerminalTab {
  return { ...persistedTerminalTab(), id: RUNTIME_TAB_ID, ptyId: 'pty-runtime' }
}

function fullyEligibleCandidate(): IdleEmptyTerminalReclaimCandidate {
  return {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    ptyId: 'pty-1',
    worktreeId: WORKTREE_ID,
    incarnationId: 'incarnation-1',
    expectedIncarnationId: 'incarnation-1',
    activityGeneration: 1,
    expectedActivityGeneration: 1,
    isSinglePane: true,
    hasExactTabLeafPtyWorktreeBinding: true,
    hasSharedPty: false,
    isPersisted: false,
    rendererOwnsPersistedTab: false,
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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OrcaRuntimeService idle empty-terminal reclaim authorities', () => {
  it('refuses stale activity when orphan adoption rebinds a PTY during inspection', async () => {
    const repoId = 'repo-adoption'
    const worktreeId = `${repoId}::/tmp/orphan-adoption`
    const tabId = '77777777-7777-4777-8777-777777777777'
    const leafId = '88888888-8888-4888-8888-888888888888'
    let session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: repoId,
      activeWorktreeId: worktreeId,
      tabsByWorktree: { [worktreeId]: [] }
    }
    let resolveInspection!: (value: {
      foregroundProcess: string
      hasChildProcesses: boolean
    }) => void
    const inspectProcess = vi.fn(
      () =>
        new Promise<{ foregroundProcess: string; hasChildProcesses: boolean }>((resolve) => {
          resolveInspection = resolve
        })
    )
    const runtime = new OrcaRuntimeService({
      ...makeStore(true, session),
      getWorkspaceSession: () => session,
      setWorkspaceSession: vi.fn((next: WorkspaceSessionState) => {
        session = next
      }),
      flushOrThrow: vi.fn(),
      getRepo: (id: string) =>
        id === repoId
          ? {
              id: repoId,
              path: '/tmp/orphan-repo',
              displayName: 'orphan repo',
              badgeColor: 'blue',
              addedAt: 1,
              connectionId: 'ssh-adoption'
            }
          : undefined,
      getRepos: () => [
        {
          id: repoId,
          path: '/tmp/orphan-repo',
          displayName: 'orphan repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-adoption'
        }
      ]
    } as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    const adoptionInternals = runtime as unknown as {
      refreshPtyWorktreeRecordsFromController: () => Promise<Set<string>>
      getLivePtyForHandle: () => unknown
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession: () => void
      notifyMobileSessionTabsChanged: () => void
      resolveWorktreeSelector: () => Promise<unknown>
      controllerTerminalIdentityByPtyId: Map<
        string,
        { handle: string; incarnationId: string; wslDistro?: string | null }
      >
    }
    runtime.setPtyController({
      spawn: vi.fn(),
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => 'zsh'),
      inspectProcess
    })
    const pty = internals.recordPtyWorktree('pty-adopt', worktreeId, {
      connected: true,
      incarnationId: 'adopt-incarnation',
      connectionId: 'ssh-adoption'
    } as never)
    adoptionInternals.controllerTerminalIdentityByPtyId.set('pty-adopt', {
      handle: 'term_adopt',
      incarnationId: 'adopt-incarnation'
    })
    vi.spyOn(adoptionInternals, 'resolveWorktreeSelector').mockResolvedValue({
      id: worktreeId,
      repoId,
      path: '/tmp/orphan-adoption',
      branch: 'main',
      displayName: 'orphan worktree'
    } as never)
    vi.spyOn(adoptionInternals, 'refreshPtyWorktreeRecordsFromController').mockResolvedValue(
      new Set(['pty-adopt'])
    )
    vi.spyOn(adoptionInternals, 'getLivePtyForHandle').mockReturnValue({ pty } as never)
    vi.spyOn(
      adoptionInternals,
      'hydrateHeadlessMobileSessionTabsFromWorkspaceSession'
    ).mockImplementation(() => undefined)
    vi.spyOn(adoptionInternals, 'notifyMobileSessionTabsChanged').mockImplementation(
      () => undefined
    )
    vi.spyOn(runtime, 'listMobileSessionTabs').mockResolvedValue({} as never)

    const pendingCandidate = internals.collectIdleEmptyTerminalReclaimCandidates()
    await vi.waitFor(() => expect(inspectProcess).toHaveBeenCalledOnce())
    await runtime.adoptTerminalOrphans({
      worktree: `id:${worktreeId}`,
      expectedTopologyRevision: 0,
      claims: [
        {
          terminal: 'term_adopt',
          ptyId: 'pty-adopt',
          incarnationId: 'adopt-incarnation',
          tabId,
          leafId
        }
      ]
    })
    resolveInspection({ foregroundProcess: 'zsh', hasChildProcesses: false })
    const [candidate] = await pendingCandidate

    expect(candidate?.activityGeneration).not.toBe(candidate?.expectedActivityGeneration)
    expect(
      evaluateIdleReclaimCandidate(
        {
          ...fullyEligibleCandidate(),
          activityGeneration: candidate?.activityGeneration ?? null,
          expectedActivityGeneration: candidate?.expectedActivityGeneration ?? null
        },
        { enabled: true },
        60 * 60 * 1000
      )
    ).toEqual({ eligible: false, reason: 'not-idle-or-activity-stale' })
    runtime.dispose()
  })

  it('treats tab-level persisted bindings as non-hot and shared with layout bindings', async () => {
    const session = getDefaultWorkspaceSession()
    const tabOnly = { ...runtimeOwnedPersistedTerminalTab(), ptyId: 'pty-tab-only' }
    const layoutTab = { ...persistedTerminalTab(), ptyId: 'pty-shared' }
    const tabLevelPeer = {
      ...runtimeOwnedPersistedTerminalTab(),
      id: HOT_TAB_ID,
      ptyId: 'pty-shared'
    }
    session.tabsByWorktree[WORKTREE_ID] = [tabOnly, layoutTab, tabLevelPeer]
    session.terminalLayoutsByTabId[TAB_ID] = {
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: 'pty-shared' }
    }
    const runtime = new OrcaRuntimeService(makeStore(true, session) as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    internals.graphStatus = 'ready'
    runtime.setPtyController({
      spawn: vi.fn(),
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => 'zsh'),
      inspectProcess: vi.fn(async () => ({ foregroundProcess: 'zsh', hasChildProcesses: false }))
    })
    const tabOnlyPty = internals.recordPtyWorktree('pty-tab-only', WORKTREE_ID, {
      connected: true,
      incarnationId: 'tab-only-incarnation',
      tabId: RUNTIME_TAB_ID,
      paneKey: RUNTIME_PANE_KEY
    })
    tabOnlyPty.creationOrigin = 'cli'
    const sharedPty = internals.recordPtyWorktree('pty-shared', WORKTREE_ID, {
      connected: true,
      incarnationId: 'shared-incarnation',
      tabId: TAB_ID,
      paneKey: PANE_KEY
    })
    sharedPty.creationOrigin = 'cli'

    const candidates = await internals.collectIdleEmptyTerminalReclaimCandidates()

    expect(candidates[0]).toMatchObject({
      ptyId: 'pty-tab-only',
      isPersisted: null,
      rendererOwnsPersistedTab: null
    })
    expect(candidates[1]).toMatchObject({
      ptyId: 'pty-shared',
      isPersisted: true,
      hasSharedPty: true
    })
    runtime.dispose()
  })

  it('finds a dispatch retained under a stale handle through its pane key', async () => {
    const runtime = new OrcaRuntimeService(makeStore(true) as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    internals.graphStatus = 'ready'
    const getActiveDispatchAssignees = vi.fn(() => [
      { assignee_handle: 'term_stale', assignee_pane_key: PANE_KEY }
    ])
    runtime.setOrchestrationDb({
      getActiveCoordinatorRun: vi.fn(() => undefined),
      getActiveDispatchAssignees
    } as never)
    runtime.setPtyController({
      spawn: vi.fn(),
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => 'zsh'),
      inspectProcess: vi.fn(async () => ({ foregroundProcess: 'zsh', hasChildProcesses: false }))
    })
    const pty = internals.recordPtyWorktree('pty-pane-dispatch', WORKTREE_ID, {
      connected: true,
      incarnationId: 'pane-dispatch-incarnation',
      tabId: TAB_ID,
      paneKey: PANE_KEY
    })
    pty.creationOrigin = 'cli'
    runtime.preAllocateHandleForPty('pty-pane-dispatch')

    const [candidate] = await internals.collectIdleEmptyTerminalReclaimCandidates()

    expect(candidate).toMatchObject({
      hasOrchestrationOwnership: true,
      hasPendingOrDispatchedContext: true
    })
    expect(getActiveDispatchAssignees).toHaveBeenCalledOnce()
    runtime.dispose()
  })

  it('collects authority-backed launch negatives for a current-runtime empty shell', async () => {
    const session = getDefaultWorkspaceSession()
    session.tabsByWorktree[WORKTREE_ID] = [{ ...persistedTerminalTab(), ptyId: 'pty-reachable' }]
    session.terminalLayoutsByTabId[TAB_ID] = {
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: 'pty-reachable' }
    }
    const runtime = new OrcaRuntimeService(makeStore(true, session) as never, undefined, {
      getAgentStatusSnapshot: () => []
    })
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    internals.graphStatus = 'ready'
    internals.tabs.set(TAB_ID, {
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      title: null,
      activeLeafId: LEAF_ID,
      layout: { type: 'leaf', leafId: LEAF_ID }
    })
    internals.leaves.set(`${TAB_ID}::${LEAF_ID}`, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      worktreeId: WORKTREE_ID,
      ptyId: 'pty-reachable',
      writable: true
    })
    runtime.setOrchestrationDb({
      getActiveCoordinatorRun: vi.fn(() => undefined),
      getActiveDispatchAssignees: vi.fn(() => [])
    } as never)
    runtime.setPtyController({
      spawn: vi.fn(),
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => 'zsh'),
      inspectProcess: vi.fn(async () => ({ foregroundProcess: 'zsh', hasChildProcesses: false }))
    })
    runtime.onPtySpawned('pty-reachable', 'reachable-incarnation')
    const pty = internals.recordPtyWorktree('pty-reachable', WORKTREE_ID, {
      connected: true,
      incarnationId: 'reachable-incarnation',
      tabId: TAB_ID,
      paneKey: PANE_KEY
    })
    pty.creationOrigin = 'cli'
    pty.lastActivityAt = 0
    runtime.preAllocateHandleForPty('pty-reachable')

    const [candidate] = await internals.collectIdleEmptyTerminalReclaimCandidates()

    const deferredFields = [
      'hasProviderSession',
      'rendererVisibility',
      'hasSecondConfirmation',
      'hasExactIdentityClaim'
    ]
    expect(
      Object.entries(candidate!)
        .filter(([, value]) => value === null)
        .map(([field]) => field)
        .sort()
    ).toEqual([...deferredFields].sort())
    expect(candidate).toMatchObject({
      hasPendingRestoreOrReconnect: false,
      hasStartupCommand: false,
      hasLaunchConfig: false,
      hasResumeProviderSession: false,
      hasLaunchAgent: false,
      hasForegroundAgent: false,
      agentStatus: 'none',
      hasOrchestrationOwnership: false
    })
    expect(
      evaluateIdleReclaimCandidate(
        {
          ...candidate!,
          // A2b-2 owns these still-deferred confirmation authorities.
          hasProviderSession: false,
          rendererVisibility: 'hidden',
          hasSecondConfirmation: true,
          hasExactIdentityClaim: true
        },
        { enabled: true, idleThresholdMs: 1 },
        Date.now()
      )
    ).toEqual({ eligible: true, closeMode: 'renderer-owned-persisted' })
    runtime.dispose()
  })

  it('caps provider inspection candidates and reports aggregate truncation', async () => {
    const runtime = new OrcaRuntimeService(makeStore(true) as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    const inspectProcess = vi.fn(async () => ({
      foregroundProcess: 'zsh',
      hasChildProcesses: false
    }))
    runtime.setPtyController({
      spawn: vi.fn(),
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => 'zsh'),
      inspectProcess
    })
    for (let index = 0; index < 65; index += 1) {
      internals.recordPtyWorktree(`pty-budget-${index}`, WORKTREE_ID, {
        connected: true,
        incarnationId: `budget-incarnation-${index}`,
        tabId: HOT_TAB_ID,
        paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
      })
    }
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)

    await internals.tickIdleEmptyTerminalReclaim()

    expect(inspectProcess).toHaveBeenCalledTimes(64)
    expect(debug).toHaveBeenCalledWith(
      '[idle-empty-terminal-reclaim] tick decisions',
      expect.objectContaining({ candidateCount: 64, truncatedCandidateCount: 1 })
    )
    runtime.dispose()
  })
})
