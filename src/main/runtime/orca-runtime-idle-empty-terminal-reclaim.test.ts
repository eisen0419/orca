import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { TerminalTab, WorkspaceSessionState } from '../../shared/types'
import { IdleEmptyTerminalReclaimScheduler } from '../idle-empty-terminal-reclaim-scheduler'
import type { IdleEmptyTerminalReclaimCandidate } from './idle-empty-terminal-reclaim'
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
      ptyIdsByLeafId: { [RUNTIME_LEAF_ID]: 'pty-runtime' }
    }
    const runtime = new OrcaRuntimeService(makeStore(true, session) as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
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

    const runtimePty = internals.recordPtyWorktree('pty-runtime', WORKTREE_ID, {
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

    expect(candidates.find((candidate) => candidate.ptyId === 'pty-renderer')).toMatchObject({
      isPersisted: true,
      rendererOwnsPersistedTab: true
    })
    expect(candidates.find((candidate) => candidate.ptyId === 'pty-runtime')).toMatchObject({
      isPersisted: true,
      rendererOwnsPersistedTab: false
    })
    expect(candidates.find((candidate) => candidate.ptyId === 'pty-hot')).toMatchObject({
      isPersisted: false,
      rendererOwnsPersistedTab: false,
      isPinned: null,
      rendererVisibility: null
    })
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
