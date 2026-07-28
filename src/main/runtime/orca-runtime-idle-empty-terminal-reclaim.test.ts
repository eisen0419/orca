import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { TerminalTab, WorkspaceSessionState } from '../../shared/types'
import { IdleEmptyTerminalReclaimScheduler } from '../idle-empty-terminal-reclaim-scheduler'
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
  authoritativeWindowId: number | null
  setDriver: (ptyId: string, next: { kind: 'idle' | 'desktop' }) => void
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
  return { ...persistedTerminalTab(), id: RUNTIME_TAB_ID, ptyId: 'serve-runtime' }
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
    authoritativePersistedOwner: null,
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

function expectedCollectedCandidate(args: {
  tabId: string
  leafId: string
  ptyId: string
  incarnationId: string
  lastActivityAt: number
  overrides?: Partial<IdleEmptyTerminalReclaimCandidate>
}): IdleEmptyTerminalReclaimCandidate {
  return {
    tabId: args.tabId,
    leafId: args.leafId,
    ptyId: args.ptyId,
    worktreeId: WORKTREE_ID,
    incarnationId: args.incarnationId,
    expectedIncarnationId: args.incarnationId,
    activityGeneration: 0,
    expectedActivityGeneration: 0,
    isSinglePane: null,
    hasExactTabLeafPtyWorktreeBinding: true,
    hasSharedPty: false,
    isPersisted: false,
    rendererOwnsPersistedTab: false,
    authoritativePersistedOwner: null,
    origin: 'cli',
    used: false,
    isPinned: null,
    isSleepingOrHibernating: null,
    hasPendingRestoreOrReconnect: null,
    hasStartupCommand: null,
    hasLaunchConfig: null,
    hasResumeProviderSession: null,
    hasLaunchAgent: null,
    hasForegroundAgent: false,
    agentStatus: null,
    hasProviderSession: null,
    hasOrchestrationOwnership: null,
    lastActivityAt: args.lastActivityAt,
    providerConnected: true,
    providerWritable: null,
    inspection: { status: 'success', foregroundProcess: 'shell', hasChildProcesses: false },
    rendererVisibility: null,
    hasMobileDriver: false,
    hasMobileSubscriber: false,
    hasRemoteDesktopViewer: false,
    isActiveCoordinatorHandle: null,
    hasPendingOrDispatchedContext: null,
    hasInFlightTransaction: false,
    hasSecondConfirmation: null,
    hasExactIdentityClaim: null,
    ...args.overrides
  }
}

function withOnlyLiveActivityFact(
  candidate: IdleEmptyTerminalReclaimCandidate
): IdleEmptyTerminalReclaimCandidate {
  return {
    ...fullyEligibleCandidate(),
    incarnationId: candidate.incarnationId,
    expectedIncarnationId: candidate.expectedIncarnationId,
    activityGeneration: candidate.activityGeneration,
    expectedActivityGeneration: candidate.expectedActivityGeneration
  }
}

function withCollectedTopologyFacts(
  candidate: IdleEmptyTerminalReclaimCandidate
): IdleEmptyTerminalReclaimCandidate {
  return {
    ...fullyEligibleCandidate(),
    isSinglePane: candidate.isSinglePane,
    hasExactTabLeafPtyWorktreeBinding: candidate.hasExactTabLeafPtyWorktreeBinding,
    hasSharedPty: candidate.hasSharedPty,
    isPersisted: candidate.isPersisted,
    rendererOwnsPersistedTab: candidate.rendererOwnsPersistedTab,
    authoritativePersistedOwner: candidate.authoritativePersistedOwner
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OrcaRuntimeService idle empty-terminal reclaim wiring', () => {
  it('starts the scheduler in the runtime constructor and disposes it on teardown', () => {
    const start = vi.spyOn(IdleEmptyTerminalReclaimScheduler.prototype, 'start')
    const dispose = vi.spyOn(IdleEmptyTerminalReclaimScheduler.prototype, 'dispose')
    const runtime = new OrcaRuntimeService(makeStore(false) as never)

    expect(start).toHaveBeenCalledTimes(1)
    runtime.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('does not collect or inspect when the feature flag is off', async () => {
    const runtime = new OrcaRuntimeService(makeStore(false) as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    const collect = vi.spyOn(internals, 'collectIdleEmptyTerminalReclaimCandidates')
    const inspectProcess = vi.fn()
    runtime.setPtyController({
      spawn: vi.fn(),
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(),
      inspectProcess
    })

    await internals.tickIdleEmptyTerminalReclaim()

    expect(collect).not.toHaveBeenCalled()
    expect(inspectProcess).not.toHaveBeenCalled()
    runtime.dispose()
  })

  it('collects renderer-owned, runtime-owned, and hot-only runtime PTY shapes', async () => {
    const session = getDefaultWorkspaceSession()
    session.tabsByWorktree[WORKTREE_ID] = [
      persistedTerminalTab(),
      runtimeOwnedPersistedTerminalTab()
    ]
    session.terminalLayoutsByTabId[TAB_ID] = {
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: 'pty-renderer' }
    }
    session.terminalLayoutsByTabId[RUNTIME_TAB_ID] = {
      root: { type: 'leaf', leafId: RUNTIME_LEAF_ID },
      activeLeafId: RUNTIME_LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [RUNTIME_LEAF_ID]: 'serve-runtime' }
    }
    const runtime = new OrcaRuntimeService(makeStore(true, session) as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    internals.graphStatus = 'ready'
    runtime.setPtyController({
      spawn: vi.fn(),
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => 'zsh'),
      hasChildProcesses: vi.fn(async () => false)
    })

    const rendererPty = internals.recordPtyWorktree('pty-renderer', WORKTREE_ID, {
      connected: true,
      incarnationId: 'renderer-incarnation',
      tabId: TAB_ID,
      paneKey: PANE_KEY
    })
    rendererPty.creationOrigin = 'cli'
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
      ptyId: 'pty-renderer',
      writable: true
    })
    internals.tabs.set(RUNTIME_TAB_ID, {
      tabId: RUNTIME_TAB_ID,
      worktreeId: WORKTREE_ID,
      title: null,
      activeLeafId: RUNTIME_LEAF_ID,
      layout: { type: 'leaf', leafId: RUNTIME_LEAF_ID },
      rendererVisibility: 'hidden'
    })
    internals.leaves.set(`${RUNTIME_TAB_ID}::${RUNTIME_LEAF_ID}`, {
      tabId: RUNTIME_TAB_ID,
      leafId: RUNTIME_LEAF_ID,
      worktreeId: WORKTREE_ID,
      ptyId: 'serve-runtime',
      writable: true
    })

    const runtimePty = internals.recordPtyWorktree('serve-runtime', WORKTREE_ID, {
      connected: true,
      incarnationId: 'runtime-incarnation',
      tabId: RUNTIME_TAB_ID,
      paneKey: RUNTIME_PANE_KEY
    })
    runtimePty.creationOrigin = 'cli'

    const hotPty = internals.recordPtyWorktree('pty-hot', WORKTREE_ID, {
      connected: true,
      incarnationId: 'hot-incarnation',
      tabId: HOT_TAB_ID,
      paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
    })
    hotPty.creationOrigin = 'cli'

    const candidates = await internals.collectIdleEmptyTerminalReclaimCandidates()

    expect(candidates).toEqual([
      expectedCollectedCandidate({
        tabId: TAB_ID,
        leafId: LEAF_ID,
        ptyId: 'pty-renderer',
        incarnationId: 'renderer-incarnation',
        lastActivityAt: rendererPty.lastActivityAt,
        overrides: {
          isSinglePane: true,
          isPersisted: true,
          rendererOwnsPersistedTab: true,
          authoritativePersistedOwner: {
            kind: 'renderer',
            source: 'ready-exact-renderer-binding'
          },
          isPinned: false,
          isSleepingOrHibernating: false,
          providerWritable: true
        }
      }),
      expectedCollectedCandidate({
        tabId: RUNTIME_TAB_ID,
        leafId: RUNTIME_LEAF_ID,
        ptyId: 'serve-runtime',
        incarnationId: 'runtime-incarnation',
        lastActivityAt: runtimePty.lastActivityAt,
        overrides: {
          isSinglePane: true,
          isPersisted: true,
          rendererOwnsPersistedTab: true,
          authoritativePersistedOwner: { kind: 'runtime', source: 'serve-or-ssh-pty-id' },
          isPinned: false,
          isSleepingOrHibernating: false,
          providerWritable: true,
          rendererVisibility: 'hidden'
        }
      }),
      expectedCollectedCandidate({
        tabId: HOT_TAB_ID,
        leafId: HOT_LEAF_ID,
        ptyId: 'pty-hot',
        incarnationId: 'hot-incarnation',
        lastActivityAt: hotPty.lastActivityAt,
        overrides: {
          isSinglePane: false,
          isPinned: false,
          isSleepingOrHibernating: false,
          providerWritable: true,
          rendererVisibility: 'hidden'
        }
      })
    ])
    runtime.dispose()
  })

  it.each([
    {
      seam: 'renderer graph invalidation',
      mutate: (runtime: OrcaRuntimeService, internals: RuntimeIdleReclaimInternals) => {
        internals.authoritativeWindowId = 1
        internals.graphStatus = 'ready'
        runtime.markGraphUnavailable(1)
      }
    },
    {
      seam: 'driver takeover',
      mutate: (_runtime: OrcaRuntimeService, internals: RuntimeIdleReclaimInternals) => {
        internals.setDriver('pty-race', { kind: 'desktop' })
      }
    },
    {
      seam: 'PTY exit',
      mutate: (runtime: OrcaRuntimeService) => {
        runtime.onPtyExit('pty-race', 0)
      }
    },
    {
      seam: 'pane rebinding',
      mutate: (_runtime: OrcaRuntimeService, internals: RuntimeIdleReclaimInternals) => {
        internals.recordPtyWorktree('pty-race', WORKTREE_ID, {
          tabId: RUNTIME_TAB_ID,
          paneKey: RUNTIME_PANE_KEY
        })
      }
    }
  ])(
    'returns the exact stale-activity refusal when $seam changes during inspection',
    async ({ mutate }) => {
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
      const runtime = new OrcaRuntimeService(makeStore(true) as never)
      const internals = runtime as unknown as RuntimeIdleReclaimInternals
      runtime.setPtyController({
        spawn: vi.fn(),
        write: vi.fn(() => true),
        kill: vi.fn(() => true),
        getForegroundProcess: vi.fn(async () => 'zsh'),
        inspectProcess
      })
      const pty = internals.recordPtyWorktree('pty-race', WORKTREE_ID, {
        connected: true,
        incarnationId: 'race-incarnation',
        tabId: HOT_TAB_ID,
        paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
      })
      pty.creationOrigin = 'cli'

      const pendingCandidate = internals.collectIdleEmptyTerminalReclaimCandidates()
      await vi.waitFor(() => expect(inspectProcess).toHaveBeenCalledOnce())
      mutate(runtime, internals)
      resolveInspection({ foregroundProcess: 'zsh', hasChildProcesses: false })
      const [candidate] = await pendingCandidate

      expect(candidate?.activityGeneration).not.toBe(candidate?.expectedActivityGeneration)
      expect(
        evaluateIdleReclaimCandidate(
          withOnlyLiveActivityFact(candidate!),
          { enabled: true },
          60 * 60 * 1000
        )
      ).toEqual({ eligible: false, reason: 'not-idle-or-activity-stale' })
      runtime.dispose()
    }
  )

  it('refuses renderer ownership when graph, session, or hot-only identity authority is unavailable', async () => {
    const session = getDefaultWorkspaceSession()
    const runtime = new OrcaRuntimeService(makeStore(true, session) as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    runtime.setPtyController({
      spawn: vi.fn(),
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => 'zsh'),
      inspectProcess: vi.fn(async () => ({ foregroundProcess: 'zsh', hasChildProcesses: false }))
    })
    const pty = internals.recordPtyWorktree('pty-unknown', WORKTREE_ID, {
      connected: true,
      incarnationId: 'unknown-incarnation',
      tabId: HOT_TAB_ID,
      paneKey: `${RUNTIME_TAB_ID}:${HOT_LEAF_ID}`
    })
    pty.creationOrigin = 'cli'

    const [unavailableGraph] = await internals.collectIdleEmptyTerminalReclaimCandidates()
    expect(unavailableGraph).toMatchObject({
      isPersisted: false,
      rendererOwnsPersistedTab: null,
      hasExactTabLeafPtyWorktreeBinding: null,
      hasSharedPty: null
    })

    internals.graphStatus = 'ready'
    const [mismatchedPane] = await internals.collectIdleEmptyTerminalReclaimCandidates()
    expect(mismatchedPane).toMatchObject({
      isPersisted: false,
      rendererOwnsPersistedTab: false,
      hasExactTabLeafPtyWorktreeBinding: null,
      hasSharedPty: false
    })
    runtime.dispose()

    const sessionlessRuntime = new OrcaRuntimeService(makeStore(true) as never)
    const sessionlessInternals = sessionlessRuntime as unknown as RuntimeIdleReclaimInternals
    sessionlessInternals.graphStatus = 'ready'
    sessionlessRuntime.setPtyController({
      spawn: vi.fn(),
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => 'zsh'),
      inspectProcess: vi.fn(async () => ({ foregroundProcess: 'zsh', hasChildProcesses: false }))
    })
    const sessionlessPty = sessionlessInternals.recordPtyWorktree('pty-sessionless', WORKTREE_ID, {
      connected: true,
      incarnationId: 'sessionless-incarnation',
      tabId: HOT_TAB_ID,
      paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
    })
    sessionlessPty.creationOrigin = 'cli'

    const [sessionlessCandidate] =
      await sessionlessInternals.collectIdleEmptyTerminalReclaimCandidates()
    expect(sessionlessCandidate).toMatchObject({
      isPersisted: null,
      rendererOwnsPersistedTab: null,
      hasSharedPty: null
    })
    sessionlessRuntime.dispose()
  })

  it('marks cross-tab persisted PTY references shared', async () => {
    const session = getDefaultWorkspaceSession()
    session.tabsByWorktree[WORKTREE_ID] = [
      persistedTerminalTab(),
      runtimeOwnedPersistedTerminalTab()
    ]
    session.terminalLayoutsByTabId[TAB_ID] = {
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: 'pty-shared' }
    }
    session.terminalLayoutsByTabId[RUNTIME_TAB_ID] = {
      root: { type: 'leaf', leafId: RUNTIME_LEAF_ID },
      activeLeafId: RUNTIME_LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [RUNTIME_LEAF_ID]: 'pty-shared' }
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
    const pty = internals.recordPtyWorktree('pty-shared', WORKTREE_ID, {
      connected: true,
      incarnationId: 'shared-incarnation',
      tabId: TAB_ID,
      paneKey: PANE_KEY
    })
    pty.creationOrigin = 'cli'

    const [candidate] = await internals.collectIdleEmptyTerminalReclaimCandidates()

    expect(candidate).toMatchObject({ isPersisted: true, hasSharedPty: true })
    expect(
      evaluateIdleReclaimCandidate(
        withCollectedTopologyFacts(candidate!),
        { enabled: true },
        60 * 60 * 1000
      )
    ).toEqual({
      eligible: false,
      reason: 'topology-or-binding-invalid'
    })
    runtime.dispose()
  })

  it('leaves orchestration facts null without constructing an unopened DB', async () => {
    const runtime = new OrcaRuntimeService(makeStore(true) as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    internals.graphStatus = 'ready'
    runtime.setPtyController({
      spawn: vi.fn(),
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => 'zsh'),
      inspectProcess: vi.fn(async () => ({ foregroundProcess: 'zsh', hasChildProcesses: false }))
    })
    const getOrchestrationDb = vi.spyOn(runtime, 'getOrchestrationDb').mockImplementation(() => {
      throw new Error('db unavailable')
    })
    const pty = internals.recordPtyWorktree('pty-db', WORKTREE_ID, {
      connected: true,
      incarnationId: 'db-incarnation',
      tabId: HOT_TAB_ID,
      paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
    })
    pty.creationOrigin = 'cli'
    runtime.preAllocateHandleForPty('pty-db')

    const [candidate] = await internals.collectIdleEmptyTerminalReclaimCandidates()

    expect(candidate).toMatchObject({
      hasOrchestrationOwnership: null,
      isActiveCoordinatorHandle: null,
      hasPendingOrDispatchedContext: null
    })
    expect(getOrchestrationDb).not.toHaveBeenCalled()
    runtime.dispose()
  })

  it('does not treat a reconstructed connected record as verified provider liveness', async () => {
    const runtime = new OrcaRuntimeService(makeStore(true) as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    internals.graphStatus = 'ready'
    runtime.setPtyController({
      spawn: vi.fn(),
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => 'zsh')
    })
    const pty = internals.recordPtyWorktree('pty-restarted', WORKTREE_ID, {
      connected: true,
      incarnationId: 'restarted-incarnation',
      tabId: HOT_TAB_ID,
      paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
    })
    pty.creationOrigin = 'cli'

    const [candidate] = await internals.collectIdleEmptyTerminalReclaimCandidates()

    expect(candidate).toMatchObject({
      providerConnected: null,
      hasStartupCommand: null,
      hasLaunchConfig: null,
      hasLaunchAgent: null,
      hasForegroundAgent: null,
      agentStatus: null
    })
    runtime.dispose()
  })

  it('re-reads the provider incarnation after inspection before evaluating the candidate', async () => {
    let resolveInspection!: (value: {
      foregroundProcess: string
      hasChildProcesses: boolean
    }) => void
    const runtime = new OrcaRuntimeService(makeStore(true) as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    internals.graphStatus = 'ready'
    const inspectProcess = vi.fn(
      () =>
        new Promise<{ foregroundProcess: string; hasChildProcesses: boolean }>((resolve) => {
          resolveInspection = resolve
        })
    )
    runtime.setPtyController({
      spawn: vi.fn(),
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => 'zsh'),
      inspectProcess
    })
    const pty = internals.recordPtyWorktree('pty-replaced', WORKTREE_ID, {
      connected: true,
      incarnationId: 'old-incarnation',
      tabId: HOT_TAB_ID,
      paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
    })
    pty.creationOrigin = 'cli'

    const pendingCandidate = internals.collectIdleEmptyTerminalReclaimCandidates()
    await vi.waitFor(() => expect(inspectProcess).toHaveBeenCalledOnce())
    pty.incarnationId = 'replacement-incarnation'
    resolveInspection({ foregroundProcess: 'zsh', hasChildProcesses: false })
    const [candidate] = await pendingCandidate

    expect(candidate).toMatchObject({
      expectedIncarnationId: 'old-incarnation',
      incarnationId: 'replacement-incarnation',
      providerConnected: null
    })
    expect(
      evaluateIdleReclaimCandidate(
        withOnlyLiveActivityFact(candidate!),
        { enabled: true },
        60 * 60 * 1000
      )
    ).toEqual({ eligible: false, reason: 'provider-unavailable-or-incarnation-stale' })
    runtime.dispose()
  })

  it('reports an in-flight worktree terminal mutation instead of assuming false', async () => {
    const mutationWorktreeId = 'repo-mutation::/tmp/idle-empty-terminal-reclaim-mutation'
    const runtime = new OrcaRuntimeService(makeStore(true) as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    internals.graphStatus = 'ready'
    runtime.setPtyController({
      spawn: vi.fn(),
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => 'zsh'),
      inspectProcess: vi.fn(async () => ({ foregroundProcess: 'zsh', hasChildProcesses: false }))
    })
    const pty = internals.recordPtyWorktree('pty-mutating', mutationWorktreeId, {
      connected: true,
      incarnationId: 'mutation-incarnation',
      tabId: HOT_TAB_ID,
      paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
    })
    pty.creationOrigin = 'cli'

    const releaseMutation = await runtime.acquireWorktreeTerminalSpawn(mutationWorktreeId)
    const [candidate] = await internals.collectIdleEmptyTerminalReclaimCandidates()

    expect(candidate?.hasInFlightTransaction).toBe(true)
    releaseMutation()
    runtime.dispose()
  })

  it('does not mistake a bare worktree id for a production mutation key', async () => {
    const mutationWorktreeId = 'repo-mutation::/tmp/idle-empty-terminal-reclaim-mutation'
    const runtime = new OrcaRuntimeService(makeStore(true) as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals & {
      terminalMutationTailByWorktreeId: Map<string, Promise<void>>
    }
    internals.graphStatus = 'ready'
    internals.terminalMutationTailByWorktreeId.set(mutationWorktreeId, Promise.resolve())
    runtime.setPtyController({
      spawn: vi.fn(),
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => 'zsh'),
      inspectProcess: vi.fn(async () => ({ foregroundProcess: 'zsh', hasChildProcesses: false }))
    })
    const pty = internals.recordPtyWorktree('pty-bare-mutation-key', mutationWorktreeId, {
      connected: true,
      incarnationId: 'bare-mutation-incarnation',
      tabId: HOT_TAB_ID,
      paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
    })
    pty.creationOrigin = 'cli'

    const [candidate] = await internals.collectIdleEmptyTerminalReclaimCandidates()

    expect(candidate?.hasInFlightTransaction).toBe(false)
    runtime.dispose()
  })

  it('logs an eligible decision without invoking any close, stop, retire, or persistence path', async () => {
    const setWorkspaceSession = vi.fn()
    const runtime = new OrcaRuntimeService({ ...makeStore(true), setWorkspaceSession } as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    vi.spyOn(internals, 'collectIdleEmptyTerminalReclaimCandidates').mockResolvedValue([
      fullyEligibleCandidate()
    ])
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const closeTerminal = vi.spyOn(runtime, 'closeTerminal')
    const closeTerminalTab = vi.spyOn(runtime, 'closeTerminalTab')
    const stopAndWait = vi.fn(async () => true)
    const kill = vi.fn(() => true)
    runtime.setPtyController({
      spawn: vi.fn(),
      write: vi.fn(() => true),
      kill,
      stopAndWait,
      getForegroundProcess: vi.fn(async () => 'zsh')
    })

    await internals.tickIdleEmptyTerminalReclaim()

    expect(closeTerminal).not.toHaveBeenCalled()
    expect(closeTerminalTab).not.toHaveBeenCalled()
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    expect(setWorkspaceSession).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith(
      '[idle-empty-terminal-reclaim] tick decisions',
      expect.objectContaining({
        candidateCount: 1,
        eligibleCount: 1,
        eligibleCloseModes: { 'hot-only': 1 }
      })
    )
    runtime.dispose()
  })
})
