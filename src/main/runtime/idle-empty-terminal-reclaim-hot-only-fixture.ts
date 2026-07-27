import { vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type {
  evaluateIdleReclaimCandidate,
  IdleEmptyTerminalReclaimCandidate
} from './idle-empty-terminal-reclaim'
import {
  HOT_INCARNATION_ID,
  HOT_LEAF_ID,
  HOT_PANE_KEY,
  HOT_PTY_ID,
  HOT_TAB_ID,
  makeHotSnapshot,
  makeStore,
  type ReclaimFixtureStore,
  WORKTREE_ID
} from './idle-empty-terminal-reclaim-lifecycle-fixture'
import { OrcaRuntimeService } from './orca-runtime'

export type RuntimeIdleReclaimInternals = {
  graphStatus: 'unavailable' | 'reloading' | 'ready'
  tabs: Map<
    string,
    { tabId: string; worktreeId: string; rendererVisibility?: 'hidden' | 'visible' }
  >
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  ptysById: Map<string, unknown>
  leaves: Map<string, unknown>
  handleByPtyId: Map<string, string>
  handles: Map<string, unknown>
  reclaimInFlightByPtyId: Map<string, unknown>
  launchFactsAuthoritativeIncarnationByPtyId: Map<string, string | null>
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
  rebuildLeafPtyIndex: () => void
  tickIdleEmptyTerminalReclaim: () => Promise<void>
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

export function fullyEligibleHotCandidate(
  activityGeneration = 0
): IdleEmptyTerminalReclaimCandidate {
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

type HotOnlyFixturePty = {
  activityGeneration: number
  creationOrigin: 'user' | 'cli' | 'orchestration' | null
  lastActivityAt: number
}

export type HotOnlyRuntimeFixture = {
  runtime: OrcaRuntimeService
  internals: RuntimeIdleReclaimInternals
  pty: HotOnlyFixturePty
  store: ReclaimFixtureStore
  spawn: (...args: never[]) => unknown
}

export function createHotOnlyRuntime(options: {
  stopAndWait: (ptyId: string) => Promise<boolean>
  hasPty: (ptyId: string) => boolean | null
  getAgentStatusSnapshot?: () => AgentStatusIpcPayload[]
  includeAgentStatusAuthority?: boolean
}): HotOnlyRuntimeFixture {
  const store = makeStore(getDefaultWorkspaceSession())
  const runtime = new OrcaRuntimeService(
    store as never,
    undefined,
    options.includeAgentStatusAuthority === false
      ? undefined
      : { getAgentStatusSnapshot: options.getAgentStatusSnapshot ?? (() => []) }
  )
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
  internals.launchFactsAuthoritativeIncarnationByPtyId.set(HOT_PTY_ID, HOT_INCARNATION_ID)
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
