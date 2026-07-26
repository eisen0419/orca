import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/types'
import {
  evaluateIdleReclaimCandidate,
  type IdleEmptyTerminalReclaimCandidate
} from './idle-empty-terminal-reclaim'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE_ID = 'worktree-1'
const HOT_TAB_ID = '55555555-5555-4555-8555-555555555555'
const HOT_LEAF_ID = '66666666-6666-4666-8666-666666666666'
const HOT_PANE_KEY = `${HOT_TAB_ID}:${HOT_LEAF_ID}`
const HOT_PTY_ID = 'pty-hot'
const HOT_INCARNATION_ID = 'hot-incarnation'

type RuntimeIdleReclaimInternals = {
  graphStatus: 'unavailable' | 'reloading' | 'ready'
  tabs: Map<
    string,
    { tabId: string; worktreeId: string; rendererVisibility?: 'hidden' | 'visible' }
  >
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  ptysById: Map<string, unknown>
  handleByPtyId: Map<string, string>
  handles: Map<string, unknown>
  reclaimInFlightByPtyId: Map<string, unknown>
  removePersistedHeadlessTerminalTab: (...args: unknown[]) => string[]
  closeHeadlessMobileTerminalTab: (...args: unknown[]) => Promise<void>
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean; incarnationId?: string; tabId?: string; paneKey?: string }
  ) => {
    ptyId: string
    incarnationId: string | null
    activityGeneration: number
    creationOrigin: 'user' | 'cli' | 'orchestration' | null
    lastActivityAt: number
  }
  collectIdleEmptyTerminalReclaimCandidates: () => Promise<IdleEmptyTerminalReclaimCandidate[]>
  collectIdleEmptyTerminalReclaimConfirmation: (
    candidate: IdleEmptyTerminalReclaimCandidate
  ) => Promise<IdleEmptyTerminalReclaimCandidate | null>
  reclaimHotOnlyIdleTerminal: (
    candidate: IdleEmptyTerminalReclaimCandidate,
    config: { enabled?: unknown; idleThresholdMs?: unknown }
  ) => Promise<{
    decision: ReturnType<typeof evaluateIdleReclaimCandidate>
    reclaimed: boolean
  } | null>
  retireHotOnlyIdleTerminal: (
    candidate: IdleEmptyTerminalReclaimCandidate,
    claim: { incarnationId: string; activityGeneration: number }
  ) => Promise<boolean>
}

function makeStore(session: WorkspaceSessionState) {
  return {
    getSettings: () => ({
      workspaceDir: '/tmp',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: '',
      branchPrefixCustom: '',
      terminalIdleEmptyReclaimEnabled: true,
      terminalIdleEmptyReclaimMs: 5 * 60 * 1000
    }),
    getWorkspaceSession: () => session,
    getRepo: () => null,
    getRepos: () => [],
    getAllWorktreeMeta: () => ({}),
    setWorkspaceSession: vi.fn(),
    flushOrThrow: vi.fn(),
    createTerminalArchiveStore: vi.fn()
  }
}

function makeHotSnapshot(): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'headless:fixture',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: HOT_TAB_ID,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `${HOT_TAB_ID}::${HOT_LEAF_ID}`,
        parentTabId: HOT_TAB_ID,
        leafId: HOT_LEAF_ID,
        ptyId: HOT_PTY_ID,
        title: 'Background shell',
        isActive: true,
        parentLayout: {
          root: { type: 'leaf', leafId: HOT_LEAF_ID },
          activeLeafId: HOT_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [HOT_LEAF_ID]: HOT_PTY_ID }
        }
      }
    ]
  }
}

function fullyEligibleHotCandidate(activityGeneration = 0): IdleEmptyTerminalReclaimCandidate {
  return {
    tabId: HOT_TAB_ID,
    leafId: HOT_LEAF_ID,
    ptyId: HOT_PTY_ID,
    worktreeId: WORKTREE_ID,
    incarnationId: HOT_INCARNATION_ID,
    expectedIncarnationId: HOT_INCARNATION_ID,
    activityGeneration,
    expectedActivityGeneration: activityGeneration,
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

function createHotOnlyRuntime(options: {
  stopAndWait: (ptyId: string) => Promise<boolean>
  hasPty: (ptyId: string) => boolean | null
  getAgentStatusSnapshot?: () => AgentStatusIpcPayload[]
}) {
  const session = getDefaultWorkspaceSession()
  const store = makeStore(session)
  const runtime = new OrcaRuntimeService(store as never, undefined, {
    getAgentStatusSnapshot: options.getAgentStatusSnapshot
  })
  const internals = runtime as unknown as RuntimeIdleReclaimInternals
  internals.graphStatus = 'ready'
  internals.mobileSessionTabsByWorktree.set(WORKTREE_ID, makeHotSnapshot())
  const pty = internals.recordPtyWorktree(HOT_PTY_ID, WORKTREE_ID, {
    connected: true,
    incarnationId: HOT_INCARNATION_ID,
    tabId: HOT_TAB_ID,
    paneKey: HOT_PANE_KEY
  })
  pty.creationOrigin = 'cli'
  const spawn = vi.fn()
  runtime.setPtyController({
    spawn,
    write: vi.fn(() => true),
    kill: vi.fn(() => true),
    stopAndWait: options.stopAndWait,
    hasPty: options.hasPty,
    getForegroundProcess: vi.fn(async () => 'zsh'),
    inspectProcess: vi.fn(async () => ({ foregroundProcess: 'zsh', hasChildProcesses: false }))
  })
  runtime.preAllocateHandleForPty(HOT_PTY_ID)
  return { runtime, internals, pty, store, spawn }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('idle empty-terminal reclaim hot-only executor', () => {
  it('reads provider-session and renderer-visibility authorities, degrading each unreadable authority to null', async () => {
    let live = true
    let providerSession = false
    const withAuthorities = createHotOnlyRuntime({
      stopAndWait: vi.fn(async () => true),
      hasPty: () => live,
      getAgentStatusSnapshot: () =>
        providerSession
          ? [
              {
                paneKey: HOT_PANE_KEY,
                state: 'done',
                prompt: '',
                connectionId: null,
                receivedAt: 1,
                stateStartedAt: 1,
                providerSession: { key: 'session_id', id: 'provider-session-1' }
              }
            ]
          : []
    })
    const [safe] = await withAuthorities.internals.collectIdleEmptyTerminalReclaimCandidates()

    expect(safe).toMatchObject({ hasProviderSession: false, rendererVisibility: 'hidden' })
    expect(
      evaluateIdleReclaimCandidate(
        { ...fullyEligibleHotCandidate(), hasProviderSession: null },
        { enabled: true },
        60 * 60 * 1000
      )
    ).toEqual({ eligible: false, reason: 'agent-or-orchestration-owned' })
    expect(
      evaluateIdleReclaimCandidate(fullyEligibleHotCandidate(), { enabled: true }, 60 * 60 * 1000)
    ).toEqual({ eligible: true, closeMode: 'hot-only' })
    expect(
      evaluateIdleReclaimCandidate(
        { ...fullyEligibleHotCandidate(), rendererVisibility: null },
        { enabled: true },
        60 * 60 * 1000
      )
    ).toEqual({ eligible: false, reason: 'renderer-visible' })
    providerSession = true
    withAuthorities.internals.tabs.set(HOT_TAB_ID, {
      tabId: HOT_TAB_ID,
      worktreeId: WORKTREE_ID,
      rendererVisibility: 'visible'
    })
    const [protectedByAuthorities] =
      await withAuthorities.internals.collectIdleEmptyTerminalReclaimCandidates()
    expect(protectedByAuthorities).toMatchObject({
      hasProviderSession: true,
      rendererVisibility: 'visible'
    })
    withAuthorities.internals.tabs.set(HOT_TAB_ID, {
      tabId: HOT_TAB_ID,
      worktreeId: 'wrong-worktree',
      rendererVisibility: 'visible'
    })
    const [mismatchedRenderer] =
      await withAuthorities.internals.collectIdleEmptyTerminalReclaimCandidates()
    expect(mismatchedRenderer?.rendererVisibility).toBeNull()
    withAuthorities.internals.graphStatus = 'unavailable'
    const [unreadableRenderer] =
      await withAuthorities.internals.collectIdleEmptyTerminalReclaimCandidates()
    expect(unreadableRenderer?.rendererVisibility).toBeNull()
    withAuthorities.runtime.dispose()

    live = true
    const withoutProviderAuthority = createHotOnlyRuntime({
      stopAndWait: vi.fn(async () => true),
      hasPty: () => live
    })
    const [unreadableProvider] =
      await withoutProviderAuthority.internals.collectIdleEmptyTerminalReclaimCandidates()
    expect(unreadableProvider?.hasProviderSession).toBeNull()
    withoutProviderAuthority.runtime.dispose()

    const duplicateProviderAuthority = createHotOnlyRuntime({
      stopAndWait: vi.fn(async () => true),
      hasPty: () => true,
      getAgentStatusSnapshot: () => [
        {
          paneKey: HOT_PANE_KEY,
          state: 'done',
          prompt: '',
          connectionId: null,
          receivedAt: 1,
          stateStartedAt: 1,
          providerSession: { key: 'session_id', id: 'provider-session-1' }
        },
        {
          paneKey: HOT_PANE_KEY,
          state: 'done',
          prompt: '',
          connectionId: null,
          receivedAt: 2,
          stateStartedAt: 2,
          providerSession: { key: 'session_id', id: 'provider-session-2' }
        }
      ]
    })
    const [ambiguousProvider] =
      await duplicateProviderAuthority.internals.collectIdleEmptyTerminalReclaimCandidates()
    expect(ambiguousProvider?.hasProviderSession).toBeNull()
    duplicateProviderAuthority.runtime.dispose()
  })

  it('retires the #10747 hot-only background shell without a persisted row or replacement PTY', async () => {
    let live = true
    const stopAndWait = vi.fn(async () => {
      live = false
      return true
    })
    const { runtime, internals, pty, store, spawn } = createHotOnlyRuntime({
      stopAndWait,
      hasPty: () => live
    })
    const removePersistedTab = vi.spyOn(internals, 'removePersistedHeadlessTerminalTab')
    const closeMobileTab = vi.spyOn(internals, 'closeHeadlessMobileTerminalTab')

    const candidate = fullyEligibleHotCandidate(pty.activityGeneration)
    vi.spyOn(internals, 'collectIdleEmptyTerminalReclaimConfirmation').mockResolvedValue(candidate)

    await expect(
      internals.reclaimHotOnlyIdleTerminal(candidate, { enabled: true })
    ).resolves.toMatchObject({
      decision: { eligible: true, closeMode: 'hot-only' },
      reclaimed: true
    })

    expect(stopAndWait).toHaveBeenCalledWith(HOT_PTY_ID)
    expect(internals.mobileSessionTabsByWorktree.get(WORKTREE_ID)?.tabs).toEqual([])
    await expect(runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).resolves.toMatchObject({
      tabs: []
    })
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
    expect(store.flushOrThrow).not.toHaveBeenCalled()
    expect(store.createTerminalArchiveStore).not.toHaveBeenCalled()
    expect(removePersistedTab).not.toHaveBeenCalled()
    expect(closeMobileTab).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(internals.ptysById.has(HOT_PTY_ID)).toBe(false)
    expect(internals.handleByPtyId.has(HOT_PTY_ID)).toBe(false)
    expect(internals.handles).toEqual(new Map())
    expect(internals.reclaimInFlightByPtyId).toEqual(new Map())
    runtime.dispose()
  })

  it('rejects a generation changed before the fence and leaves no claim behind', async () => {
    let live = true
    const stopAndWait = vi.fn(async () => true)
    const { runtime, internals, pty } = createHotOnlyRuntime({
      stopAndWait,
      hasPty: () => live
    })
    const captured = fullyEligibleHotCandidate(pty.activityGeneration)
    pty.activityGeneration += 1

    await expect(
      internals.reclaimHotOnlyIdleTerminal(captured, { enabled: true })
    ).resolves.toBeNull()
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(internals.reclaimInFlightByPtyId).toEqual(new Map())
    runtime.dispose()
  })

  it('aborts before stop when the captured origin no longer matches the live PTY', async () => {
    const live = true
    const stopAndWait = vi.fn(async () => true)
    const { runtime, internals, pty } = createHotOnlyRuntime({ stopAndWait, hasPty: () => live })
    const candidate = fullyEligibleHotCandidate(pty.activityGeneration)
    pty.creationOrigin = 'user'
    vi.spyOn(internals, 'collectIdleEmptyTerminalReclaimConfirmation').mockResolvedValue(candidate)

    await expect(
      internals.reclaimHotOnlyIdleTerminal(candidate, { enabled: true })
    ).resolves.toMatchObject({
      decision: { eligible: false, reason: 'topology-or-binding-invalid' },
      reclaimed: false
    })
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(internals.reclaimInFlightByPtyId).toEqual(new Map())
    runtime.dispose()
  })

  it('does not remove hot mappings when identity changes while stop is in flight', async () => {
    let live = true
    let updateLiveIdentity = () => {}
    const stopAndWait = vi.fn(async () => {
      live = false
      updateLiveIdentity()
      return true
    })
    const { runtime, internals, pty, store } = createHotOnlyRuntime({
      stopAndWait,
      hasPty: () => live
    })
    const candidate = fullyEligibleHotCandidate(pty.activityGeneration)
    updateLiveIdentity = () => {
      pty.creationOrigin = 'user'
    }
    vi.spyOn(internals, 'collectIdleEmptyTerminalReclaimConfirmation').mockResolvedValue(candidate)

    await expect(
      internals.reclaimHotOnlyIdleTerminal(candidate, { enabled: true })
    ).resolves.toMatchObject({
      decision: { eligible: true, closeMode: 'hot-only' },
      reclaimed: false
    })
    expect(internals.mobileSessionTabsByWorktree.get(WORKTREE_ID)?.tabs).toHaveLength(1)
    expect(internals.ptysById.has(HOT_PTY_ID)).toBe(true)
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
    expect(store.flushOrThrow).not.toHaveBeenCalled()
    expect(store.createTerminalArchiveStore).not.toHaveBeenCalled()
    expect(internals.reclaimInFlightByPtyId).toEqual(new Map())
    runtime.dispose()
  })

  it('fences concurrent reclaim attempts and releases the claim after provider failure', async () => {
    let live = true
    let releaseStop!: () => void
    const stop = new Promise<boolean>((resolve) => {
      releaseStop = () => resolve(true)
    })
    const stopAndWait = vi.fn(async () => {
      const stopped = await stop
      live = false
      return stopped
    })
    const { runtime, internals, pty } = createHotOnlyRuntime({ stopAndWait, hasPty: () => live })
    const candidate = fullyEligibleHotCandidate(pty.activityGeneration)
    vi.spyOn(internals, 'collectIdleEmptyTerminalReclaimConfirmation').mockResolvedValue(candidate)

    const first = internals.reclaimHotOnlyIdleTerminal(candidate, { enabled: true })
    await vi.waitFor(() => expect(stopAndWait).toHaveBeenCalledOnce())
    await expect(
      internals.reclaimHotOnlyIdleTerminal(candidate, { enabled: true })
    ).resolves.toBeNull()
    releaseStop()
    await expect(first).resolves.toMatchObject({ reclaimed: true })
    expect(internals.reclaimInFlightByPtyId).toEqual(new Map())
    runtime.dispose()

    const throwing = createHotOnlyRuntime({
      stopAndWait: vi.fn(async () => {
        throw new Error('provider stopped responding')
      }),
      hasPty: () => true
    })
    const throwingCandidate = fullyEligibleHotCandidate(throwing.pty.activityGeneration)
    vi.spyOn(throwing.internals, 'collectIdleEmptyTerminalReclaimConfirmation').mockResolvedValue(
      throwingCandidate
    )

    await expect(
      throwing.internals.reclaimHotOnlyIdleTerminal(throwingCandidate, { enabled: true })
    ).resolves.toMatchObject({
      decision: { eligible: false, reason: 'final-confirmation-or-claim-missing' },
      reclaimed: false
    })
    expect(throwing.internals.reclaimInFlightByPtyId).toEqual(new Map())
    throwing.runtime.dispose()
  })

  it('aborts before stop when a persisted row appears during final confirmation', async () => {
    let live = true
    const stopAndWait = vi.fn(async () => true)
    const { runtime, internals, pty } = createHotOnlyRuntime({ stopAndWait, hasPty: () => live })
    const candidate = fullyEligibleHotCandidate(pty.activityGeneration)
    const persisted = { ...candidate, isPersisted: true, rendererOwnsPersistedTab: false }
    vi.spyOn(internals, 'collectIdleEmptyTerminalReclaimConfirmation').mockResolvedValue(persisted)

    await expect(
      internals.reclaimHotOnlyIdleTerminal(candidate, { enabled: true })
    ).resolves.toMatchObject({
      decision: { eligible: false, reason: 'topology-or-binding-invalid' },
      reclaimed: false
    })
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(internals.reclaimInFlightByPtyId).toEqual(new Map())
    runtime.dispose()
  })
})
