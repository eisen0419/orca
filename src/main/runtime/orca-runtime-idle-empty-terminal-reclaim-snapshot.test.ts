import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { TerminalTab, WorkspaceSessionState } from '../../shared/types'
import type { IdleEmptyTerminalReclaimCandidate } from './idle-empty-terminal-reclaim'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE_ID = 'worktree-1'
const TAB_ID = '11111111-1111-4111-8111-111111111111'
const HOT_TAB_ID = '55555555-5555-4555-8555-555555555555'
const HOT_LEAF_ID = '66666666-6666-4666-8666-666666666666'
const SNAPSHOT_BUDGET_MS = 50

type RuntimeIdleReclaimInternals = {
  tickIdleEmptyTerminalReclaim: () => Promise<void>
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
  dropDisconnectedPtyRecord: (ptyId: string) => void
}

type RuntimeIdleReclaimPty = ReturnType<RuntimeIdleReclaimInternals['recordPtyWorktree']>

function makeStore(session: WorkspaceSessionState | null = null) {
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

function configurePtyController(
  runtime: OrcaRuntimeService,
  inspectProcess: (
    ptyId: string
  ) => Promise<{ foregroundProcess: string; hasChildProcesses: boolean }>
) {
  runtime.setPtyController({
    spawn: vi.fn(),
    write: vi.fn(() => true),
    kill: vi.fn(() => true),
    getForegroundProcess: vi.fn(async () => 'zsh'),
    inspectProcess
  })
}

function collectSnapshotCandidate(
  internals: RuntimeIdleReclaimInternals,
  pty: RuntimeIdleReclaimPty
): IdleEmptyTerminalReclaimCandidate {
  const snapshotInternals = internals as unknown as {
    collectIdleEmptyTerminalReclaimTickSnapshot: (
      ptys: readonly RuntimeIdleReclaimPty[],
      deadline: number
    ) => unknown
    collectIdleEmptyTerminalReclaimCandidateSnapshot: (
      snapshotPty: RuntimeIdleReclaimPty,
      tick: unknown
    ) => IdleEmptyTerminalReclaimCandidate
  }
  const tick = snapshotInternals.collectIdleEmptyTerminalReclaimTickSnapshot([pty], 50)
  return snapshotInternals.collectIdleEmptyTerminalReclaimCandidateSnapshot(pty, tick)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OrcaRuntimeService idle empty-terminal reclaim snapshots', () => {
  it('eventually inspects every deferred PTY during sustained snapshot exhaustion', async () => {
    let now = 0
    const runtime = new OrcaRuntimeService({
      ...makeStore(),
      getWorkspaceSession: () => {
        now = SNAPSHOT_BUDGET_MS
        return null
      }
    } as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    const inspectProcess = vi.fn(async (_ptyId: string) => ({
      foregroundProcess: 'zsh',
      hasChildProcesses: false
    }))
    configurePtyController(runtime, inspectProcess)
    for (let index = 0; index < 3; index += 1) {
      internals.recordPtyWorktree(`pty-exhausted-${index}`, WORKTREE_ID, {
        connected: true,
        incarnationId: `exhausted-incarnation-${index}`,
        tabId: HOT_TAB_ID,
        paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
      })
    }
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    await internals.tickIdleEmptyTerminalReclaim()
    now = 0
    await internals.tickIdleEmptyTerminalReclaim()
    now = 0
    await internals.tickIdleEmptyTerminalReclaim()

    expect(inspectProcess.mock.calls.map(([ptyId]) => ptyId)).toEqual([
      'pty-exhausted-0',
      'pty-exhausted-1',
      'pty-exhausted-2'
    ])
    runtime.dispose()
  })

  it('continues after a deleted cursor instead of restarting at the Map prefix', async () => {
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    const inspectProcess = vi.fn(async (ptyId: string) => ({
      foregroundProcess: 'zsh',
      hasChildProcesses: false,
      ptyId
    }))
    configurePtyController(runtime, inspectProcess)
    for (let index = 0; index < 130; index += 1) {
      internals.recordPtyWorktree(`pty-stale-cursor-${index}`, WORKTREE_ID, {
        connected: true,
        incarnationId: `stale-cursor-incarnation-${index}`,
        tabId: HOT_TAB_ID,
        paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
      })
    }

    await internals.tickIdleEmptyTerminalReclaim()
    internals.dropDisconnectedPtyRecord('pty-stale-cursor-63')
    inspectProcess.mockClear()
    await internals.tickIdleEmptyTerminalReclaim()

    expect(inspectProcess).toHaveBeenCalledTimes(64)
    expect(inspectProcess.mock.calls[0]?.[0]).toBe('pty-stale-cursor-64')
    expect(inspectProcess.mock.calls[63]?.[0]).toBe('pty-stale-cursor-127')
    expect(inspectProcess).not.toHaveBeenCalledWith('pty-stale-cursor-0')
    runtime.dispose()
  })

  it('stops a large persisted-binding snapshot before later authorities and preserves nulls', () => {
    let now = 0
    let exhaustAtBindingCheckpoint = true
    const session = getDefaultWorkspaceSession()
    const agentSnapshot = vi.fn(() => [])
    session.tabsByWorktree[WORKTREE_ID] = Array.from({ length: 64 }, (_, index) => {
      const tab = { ...persistedTerminalTab(), id: `large-persisted-tab-${index}` }
      if (index === 62) {
        Object.defineProperty(tab, 'id', {
          enumerable: true,
          get: () => {
            if (exhaustAtBindingCheckpoint) {
              now = SNAPSHOT_BUDGET_MS
              exhaustAtBindingCheckpoint = false
            }
            return 'large-persisted-tab-62'
          }
        })
      }
      if (index === 63) {
        Object.defineProperty(tab, 'id', {
          enumerable: true,
          get: () => {
            now = 0
            return 'large-persisted-tab-63'
          }
        })
      }
      return tab
    })
    const runtime = new OrcaRuntimeService(makeStore(session) as never, undefined, {
      getAgentStatusSnapshot: agentSnapshot
    })
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    const pty = internals.recordPtyWorktree('pty-large-persisted-snapshot', WORKTREE_ID, {
      connected: true,
      incarnationId: 'large-persisted-snapshot',
      tabId: HOT_TAB_ID,
      paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
    })
    const snapshotInternals = internals as unknown as {
      collectIdleEmptyTerminalReclaimTickSnapshot: (
        ptys: readonly (typeof pty)[],
        deadline: number
      ) => unknown
      collectIdleEmptyTerminalReclaimCandidateSnapshot: (
        snapshotPty: typeof pty,
        tick: unknown
      ) => IdleEmptyTerminalReclaimCandidate
    }
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const tick = snapshotInternals.collectIdleEmptyTerminalReclaimTickSnapshot([pty], 50)
    const candidate = snapshotInternals.collectIdleEmptyTerminalReclaimCandidateSnapshot(pty, tick)

    expect(agentSnapshot).not.toHaveBeenCalled()
    expect(candidate).toMatchObject({ isPersisted: null, hasSharedPty: null, agentStatus: null })
    runtime.dispose()
  })

  it('stops a large renderer-leaf snapshot before later authorities and preserves nulls', () => {
    let now = 0
    const session = getDefaultWorkspaceSession()
    session.tabsByWorktree[WORKTREE_ID] = []
    const agentSnapshot = vi.fn(() => [])
    const runtime = new OrcaRuntimeService(makeStore(session) as never, undefined, {
      getAgentStatusSnapshot: agentSnapshot
    })
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    internals.graphStatus = 'ready'
    const pty = internals.recordPtyWorktree('pty-large-renderer-snapshot', WORKTREE_ID, {
      connected: true,
      incarnationId: 'large-renderer-snapshot',
      tabId: HOT_TAB_ID,
      paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
    })
    internals.tabs.set(HOT_TAB_ID, {
      tabId: HOT_TAB_ID,
      worktreeId: WORKTREE_ID,
      title: null,
      activeLeafId: HOT_LEAF_ID,
      layout: { type: 'leaf', leafId: HOT_LEAF_ID }
    })
    for (let index = 0; index < 64; index += 1) {
      const leafId = index === 0 ? HOT_LEAF_ID : `large-renderer-leaf-${index}`
      const leaf = {
        tabId: HOT_TAB_ID,
        leafId,
        worktreeId: WORKTREE_ID,
        ptyId: index === 0 ? pty.ptyId : `renderer-peer-${index}`,
        writable: true
      }
      if (index === 61) {
        Object.defineProperty(leaf, 'ptyId', {
          enumerable: true,
          get: () => {
            now = SNAPSHOT_BUDGET_MS
            return 'renderer-peer-61'
          }
        })
      }
      if (index === 62) {
        Object.defineProperty(leaf, 'ptyId', {
          enumerable: true,
          get: () => {
            now = 0
            return 'renderer-peer-62'
          }
        })
      }
      internals.leaves.set(`${HOT_TAB_ID}::${leafId}`, leaf)
    }
    const snapshotInternals = internals as unknown as {
      collectIdleEmptyTerminalReclaimTickSnapshot: (
        ptys: readonly (typeof pty)[],
        deadline: number
      ) => unknown
      collectIdleEmptyTerminalReclaimCandidateSnapshot: (
        snapshotPty: typeof pty,
        tick: unknown
      ) => IdleEmptyTerminalReclaimCandidate
    }
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const tick = snapshotInternals.collectIdleEmptyTerminalReclaimTickSnapshot([pty], 50)
    const candidate = snapshotInternals.collectIdleEmptyTerminalReclaimCandidateSnapshot(pty, tick)

    expect(agentSnapshot).not.toHaveBeenCalled()
    expect(candidate).toMatchObject({ isPersisted: false, hasSharedPty: null, agentStatus: null })
    runtime.dispose()
  })

  it('stops a large agent-hook snapshot before orchestration and preserves nulls', () => {
    let now = 0
    const getActiveDispatchAssignees = vi.fn(() => [])
    const getActiveCoordinatorRun = vi.fn(() => undefined)
    const runtime = new OrcaRuntimeService(
      makeStore(getDefaultWorkspaceSession()) as never,
      undefined,
      {
        getAgentStatusSnapshot: (() => {
          const statuses = Array.from({ length: 64 }, (_, index) => ({
            paneKey: index === 0 ? `${HOT_TAB_ID}:${HOT_LEAF_ID}` : `agent-pane-${index}`,
            state: 'none' as const
          }))
          Object.defineProperty(statuses, Symbol.iterator, {
            value: function* () {
              for (const [index, status] of statuses.entries()) {
                if (index === 61) {
                  now = SNAPSHOT_BUDGET_MS
                }
                if (index === 62) {
                  now = 0
                }
                yield status
              }
            }
          })
          return statuses
        }) as never
      }
    )
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    runtime.setOrchestrationDb({ getActiveDispatchAssignees, getActiveCoordinatorRun } as never)
    const pty = internals.recordPtyWorktree('pty-agent-hook-snapshot', WORKTREE_ID, {
      connected: true,
      incarnationId: 'agent-hook-snapshot',
      tabId: HOT_TAB_ID,
      paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
    })
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const candidate = collectSnapshotCandidate(internals, pty)

    expect(getActiveDispatchAssignees).not.toHaveBeenCalled()
    expect(candidate).toMatchObject({ agentStatus: null, hasOrchestrationOwnership: null })
    runtime.dispose()
  })

  it('stops a large handle-index snapshot before orchestration and preserves nulls', () => {
    let now = 0
    const getActiveDispatchAssignees = vi.fn(() => [])
    const runtime = new OrcaRuntimeService(makeStore(getDefaultWorkspaceSession()) as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    const handleInternals = internals as unknown as { handleByPtyId: Map<string, string> }
    const handleEntries: [string, string][] = Array.from({ length: 64 }, (_, index) => [
      index === 0 ? 'pty-handle-snapshot' : `pty-handle-${index}`,
      `term-handle-${index}`
    ])
    const handlesByPtyId = new Map(handleEntries)
    Object.defineProperty(handlesByPtyId, Symbol.iterator, {
      value: function* () {
        for (const [index, entry] of handleEntries.entries()) {
          if (index === 61) {
            now = SNAPSHOT_BUDGET_MS
          }
          if (index === 62) {
            now = 0
          }
          yield entry
        }
      }
    })
    handleInternals.handleByPtyId = handlesByPtyId
    runtime.setOrchestrationDb({
      getActiveDispatchAssignees,
      getActiveCoordinatorRun: vi.fn(() => undefined)
    } as never)
    const pty = internals.recordPtyWorktree('pty-handle-snapshot', WORKTREE_ID, {
      connected: true,
      incarnationId: 'handle-snapshot',
      tabId: HOT_TAB_ID,
      paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
    })
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const candidate = collectSnapshotCandidate(internals, pty)

    expect(getActiveDispatchAssignees).not.toHaveBeenCalled()
    expect(candidate).toMatchObject({ hasOrchestrationOwnership: null })
    runtime.dispose()
  })

  it('stops a large archive snapshot before orchestration and preserves nulls', () => {
    let now = 0
    const getActiveDispatchAssignees = vi.fn(() => [])
    const runtime = new OrcaRuntimeService(makeStore(getDefaultWorkspaceSession()) as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    const archiveInternals = internals as unknown as {
      headlessTerminalArchiveByOperationId: Map<string, Promise<string>>
    }
    const operationIds = Array.from({ length: 64 }, (_, index) => `archive-operation-${index}`)
    const archives = new Map(
      operationIds.map((operationId) => [operationId, Promise.resolve('done')])
    )
    Object.defineProperty(archives, 'keys', {
      value: function* () {
        for (const [index, operationId] of operationIds.entries()) {
          if (index === 61) {
            now = SNAPSHOT_BUDGET_MS
          }
          if (index === 62) {
            now = 0
          }
          yield operationId
        }
      }
    })
    archiveInternals.headlessTerminalArchiveByOperationId = archives
    runtime.setOrchestrationDb({
      getActiveDispatchAssignees,
      getActiveCoordinatorRun: vi.fn(() => undefined)
    } as never)
    const pty = internals.recordPtyWorktree('pty-archive-snapshot', WORKTREE_ID, {
      connected: true,
      incarnationId: 'archive-snapshot',
      tabId: HOT_TAB_ID,
      paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
    })
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const candidate = collectSnapshotCandidate(internals, pty)

    expect(getActiveDispatchAssignees).not.toHaveBeenCalled()
    expect(candidate).toMatchObject({ hasInFlightTransaction: null })
    runtime.dispose()
  })

  it('stops a large orchestration snapshot before coordinator lookup and preserves nulls', () => {
    let now = 0
    const runtime = new OrcaRuntimeService(makeStore(getDefaultWorkspaceSession()) as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    const handleInternals = internals as unknown as { handleByPtyId: Map<string, string> }
    handleInternals.handleByPtyId.set('pty-orchestration-snapshot', 'term-orchestration')
    const activeDispatches = Array.from({ length: 64 }, (_, index) => ({
      assignee_handle: `dispatch-${index}`,
      assignee_pane_key: null
    }))
    Object.defineProperty(activeDispatches, Symbol.iterator, {
      value: function* () {
        for (const [index, dispatch] of activeDispatches.entries()) {
          if (index === 61) {
            now = SNAPSHOT_BUDGET_MS
          }
          if (index === 62) {
            now = 0
          }
          yield dispatch
        }
      }
    })
    const getActiveCoordinatorRun = vi.fn(() => undefined)
    runtime.setOrchestrationDb({
      getActiveDispatchAssignees: vi.fn(() => activeDispatches),
      getActiveCoordinatorRun
    } as never)
    const pty = internals.recordPtyWorktree('pty-orchestration-snapshot', WORKTREE_ID, {
      connected: true,
      incarnationId: 'orchestration-snapshot',
      tabId: HOT_TAB_ID,
      paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
    })
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const candidate = collectSnapshotCandidate(internals, pty)

    expect(getActiveCoordinatorRun).not.toHaveBeenCalled()
    expect(candidate).toMatchObject({ hasOrchestrationOwnership: null })
    runtime.dispose()
  })
})
