import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { TerminalLayoutSnapshot, TerminalTab, WorkspaceSessionState } from '../../shared/types'
import type { IdleEmptyTerminalReclaimCandidate } from './idle-empty-terminal-reclaim'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE_ID = 'worktree-1'
const OTHER_WORKTREE_ID = 'worktree-other'
const HOT_TAB_ID = '55555555-5555-4555-8555-555555555555'
const HOT_LEAF_ID = '66666666-6666-4666-8666-666666666666'
const SNAPSHOT_BUDGET_MS = 50
const LARGE_SOURCE_SIZE = 64

type SnapshotInternals = {
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
  }
  tabs: Map<string, unknown>
  graphStatus: 'unavailable' | 'reloading' | 'ready'
}

type SnapshotPty = ReturnType<SnapshotInternals['recordPtyWorktree']>

type SnapshotCollectors = {
  collectIdleEmptyTerminalReclaimTickSnapshot: (
    ptys: readonly SnapshotPty[],
    deadline: number
  ) => unknown
  collectIdleEmptyTerminalReclaimCandidateSnapshot: (
    pty: SnapshotPty,
    tick: unknown
  ) => IdleEmptyTerminalReclaimCandidate
}

type RuntimeHandleMaps = {
  handleByLeafKey: Map<string, string>
  handles: Map<string, { ptyId: string | null; leafId: string | null }>
  terminalSleepStateByWorktreeId: Map<string, { ptyIds: Set<string> }>
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
    getWorkspaceSession: () => session
  }
}

function makeTerminalTab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: WORKTREE_ID,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    creationOrigin: 'cli'
  }
}

function makeTerminalLayout(ptyIdsByLeafId: Record<string, string> = {}): TerminalLayoutSnapshot {
  return {
    root: null,
    activeLeafId: null,
    expandedLeafId: null,
    ptyIdsByLeafId
  }
}

function makeLargePtyIds(prefix: string): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: LARGE_SOURCE_SIZE }, (_, index) => [
      `${prefix}-leaf-${index}`,
      `${prefix}-pty-${index}`
    ])
  )
}

function recordSnapshotPty(internals: SnapshotInternals, ptyId: string): SnapshotPty {
  return internals.recordPtyWorktree(ptyId, WORKTREE_ID, {
    connected: true,
    incarnationId: `${ptyId}-incarnation`,
    tabId: HOT_TAB_ID,
    paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
  })
}

function collectSnapshotCandidate(
  internals: SnapshotInternals,
  pty: SnapshotPty
): IdleEmptyTerminalReclaimCandidate {
  const collectors = internals as unknown as SnapshotCollectors
  const tick = collectors.collectIdleEmptyTerminalReclaimTickSnapshot([pty], SNAPSHOT_BUDGET_MS)
  return collectors.collectIdleEmptyTerminalReclaimCandidateSnapshot(pty, tick)
}

function expireClockAtCall(expiringCall: number): void {
  let calls = 0
  let exhausted = false
  vi.spyOn(Date, 'now').mockImplementation(() => {
    calls += 1
    if (calls === expiringCall) {
      exhausted = true
    }
    return exhausted ? SNAPSHOT_BUDGET_MS : 0
  })
}

function makeDeadlineExhaustingMap<T>(
  entries: [string, T][],
  setNow: (value: number) => void
): Map<string, T> {
  const map = new Map(entries)
  Object.defineProperty(map, Symbol.iterator, {
    value: function* () {
      for (const [index, entry] of entries.entries()) {
        if (index === 61) {
          setNow(SNAPSHOT_BUDGET_MS)
        }
        if (index === 62) {
          setNow(0)
        }
        yield entry
      }
    }
  })
  return map
}

function makeDeadlineExhaustingSet(values: string[], setNow: (value: number) => void): Set<string> {
  const set = new Set(values)
  Object.defineProperty(set, Symbol.iterator, {
    value: function* () {
      for (const [index, value] of values.entries()) {
        if (index === 61) {
          setNow(SNAPSHOT_BUDGET_MS)
        }
        if (index === 62) {
          setNow(0)
        }
        yield value
      }
    }
  })
  return set
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OrcaRuntimeService idle empty-terminal reclaim remaining checkpoint net', () => {
  it('stops large persisted layout rows before agent status and preserves nulls', () => {
    const session = getDefaultWorkspaceSession()
    session.tabsByWorktree = {}
    session.terminalLayoutsByTabId = Object.fromEntries(
      Array.from({ length: LARGE_SOURCE_SIZE }, (_, index) => [
        `layout-row-${index}`,
        makeTerminalLayout()
      ])
    )
    const agentSnapshot = vi.fn(() => [])
    const runtime = new OrcaRuntimeService(makeStore(session) as never, undefined, {
      getAgentStatusSnapshot: agentSnapshot
    })
    const internals = runtime as unknown as SnapshotInternals
    const pty = recordSnapshotPty(internals, 'pty-layout-rows')
    expireClockAtCall(64)

    const candidate = collectSnapshotCandidate(internals, pty)

    expect(agentSnapshot).not.toHaveBeenCalled()
    expect(candidate).toMatchObject({ isPersisted: null, hasSharedPty: null, agentStatus: null })
    runtime.dispose()
  })

  it('stops one large persisted layout before agent status and preserves nulls', () => {
    const session = getDefaultWorkspaceSession()
    session.tabsByWorktree = {}
    session.terminalLayoutsByTabId = {
      'one-large-layout': makeTerminalLayout(makeLargePtyIds('one-layout'))
    }
    const agentSnapshot = vi.fn(() => [])
    const runtime = new OrcaRuntimeService(makeStore(session) as never, undefined, {
      getAgentStatusSnapshot: agentSnapshot
    })
    const internals = runtime as unknown as SnapshotInternals
    const pty = recordSnapshotPty(internals, 'pty-layout-contents')
    expireClockAtCall(65)

    const candidate = collectSnapshotCandidate(internals, pty)

    expect(agentSnapshot).not.toHaveBeenCalled()
    expect(candidate).toMatchObject({ isPersisted: null, hasSharedPty: null, agentStatus: null })
    runtime.dispose()
  })

  it('stops the second large persisted tab pass before agent status and preserves nulls', () => {
    const session = getDefaultWorkspaceSession()
    session.tabsByWorktree = {
      [WORKTREE_ID]: Array.from({ length: LARGE_SOURCE_SIZE }, (_, index) =>
        makeTerminalTab(`second-pass-tab-${index}`)
      )
    }
    session.terminalLayoutsByTabId = {}
    const agentSnapshot = vi.fn(() => [])
    const runtime = new OrcaRuntimeService(makeStore(session) as never, undefined, {
      getAgentStatusSnapshot: agentSnapshot
    })
    const internals = runtime as unknown as SnapshotInternals
    const pty = recordSnapshotPty(internals, 'pty-second-tab-pass')
    expireClockAtCall(128)

    const candidate = collectSnapshotCandidate(internals, pty)

    expect(agentSnapshot).not.toHaveBeenCalled()
    expect(candidate).toMatchObject({ isPersisted: null, hasSharedPty: null, agentStatus: null })
    runtime.dispose()
  })

  it('stops a mismatched tab layout binding before agent status and preserves nulls', () => {
    const session = getDefaultWorkspaceSession()
    const duplicateTabId = 'mismatched-layout-tab'
    session.tabsByWorktree = {
      [WORKTREE_ID]: [makeTerminalTab(duplicateTabId)],
      [OTHER_WORKTREE_ID]: [makeTerminalTab(duplicateTabId)]
    }
    const layout = makeTerminalLayout()
    let ptyMapReads = 0
    Object.defineProperty(layout, 'ptyIdsByLeafId', {
      get: () => {
        ptyMapReads += 1
        return ptyMapReads === 1 ? {} : makeLargePtyIds('mismatched-layout')
      }
    })
    session.terminalLayoutsByTabId = { [duplicateTabId]: layout }
    const agentSnapshot = vi.fn(() => [])
    const runtime = new OrcaRuntimeService(makeStore(session) as never, undefined, {
      getAgentStatusSnapshot: agentSnapshot
    })
    const internals = runtime as unknown as SnapshotInternals
    const pty = recordSnapshotPty(internals, 'pty-mismatched-layout')
    expireClockAtCall(68)

    const candidate = collectSnapshotCandidate(internals, pty)

    expect(agentSnapshot).not.toHaveBeenCalled()
    expect(candidate).toMatchObject({ isPersisted: null, hasSharedPty: null, agentStatus: null })
    runtime.dispose()
  })

  it('stops a matching tab layout binding before agent status and preserves nulls', () => {
    const session = getDefaultWorkspaceSession()
    const matchingTabId = 'matching-layout-tab'
    session.tabsByWorktree = { [WORKTREE_ID]: [makeTerminalTab(matchingTabId)] }
    session.terminalLayoutsByTabId = {
      [matchingTabId]: makeTerminalLayout(makeLargePtyIds('matching-layout'))
    }
    const agentSnapshot = vi.fn(() => [])
    const runtime = new OrcaRuntimeService(makeStore(session) as never, undefined, {
      getAgentStatusSnapshot: agentSnapshot
    })
    const internals = runtime as unknown as SnapshotInternals
    const pty = recordSnapshotPty(internals, 'pty-matching-layout')
    expireClockAtCall(67)

    const candidate = collectSnapshotCandidate(internals, pty)

    expect(agentSnapshot).not.toHaveBeenCalled()
    expect(candidate).toMatchObject({ isPersisted: null, hasSharedPty: null, agentStatus: null })
    runtime.dispose()
  })

  it('stops large renderer tabs before agent status and preserves nulls', () => {
    let now = 0
    const session = getDefaultWorkspaceSession()
    session.tabsByWorktree = {}
    session.terminalLayoutsByTabId = {}
    const agentSnapshot = vi.fn(() => [])
    const runtime = new OrcaRuntimeService(makeStore(session) as never, undefined, {
      getAgentStatusSnapshot: agentSnapshot
    })
    const internals = runtime as unknown as SnapshotInternals
    internals.graphStatus = 'ready'
    internals.tabs = makeDeadlineExhaustingMap(
      Array.from({ length: LARGE_SOURCE_SIZE }, (_, index) => {
        const tabId = index === 0 ? HOT_TAB_ID : `renderer-tab-${index}`
        return [
          tabId,
          {
            tabId,
            worktreeId: WORKTREE_ID,
            title: null,
            activeLeafId: null,
            layout: null
          }
        ]
      }),
      (value) => {
        now = value
      }
    )
    const pty = recordSnapshotPty(internals, 'pty-renderer-tabs')
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const candidate = collectSnapshotCandidate(internals, pty)

    expect(agentSnapshot).not.toHaveBeenCalled()
    expect(candidate).toMatchObject({ hasSharedPty: null, agentStatus: null })
    runtime.dispose()
  })

  it('stops the second large handle map before orchestration and preserves nulls', () => {
    let now = 0
    const session = getDefaultWorkspaceSession()
    const getActiveDispatchAssignees = vi.fn(() => [])
    const runtime = new OrcaRuntimeService(makeStore(session) as never)
    const internals = runtime as unknown as SnapshotInternals
    const handleMaps = internals as unknown as RuntimeHandleMaps
    handleMaps.handleByLeafKey = makeDeadlineExhaustingMap(
      Array.from({ length: LARGE_SOURCE_SIZE }, (_, index) => [
        `${HOT_TAB_ID}:${index === 0 ? HOT_LEAF_ID : `leaf-${index}`}`,
        `handle-${index}`
      ]),
      (value) => {
        now = value
      }
    )
    runtime.setOrchestrationDb({
      getActiveDispatchAssignees,
      getActiveCoordinatorRun: vi.fn(() => undefined)
    } as never)
    const pty = recordSnapshotPty(internals, 'pty-second-handle-map')
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const candidate = collectSnapshotCandidate(internals, pty)

    expect(getActiveDispatchAssignees).not.toHaveBeenCalled()
    expect(candidate).toMatchObject({ hasOrchestrationOwnership: null })
    runtime.dispose()
  })

  it('stops the third large handle map before orchestration and preserves nulls', () => {
    let now = 0
    const session = getDefaultWorkspaceSession()
    const getActiveDispatchAssignees = vi.fn(() => [])
    const runtime = new OrcaRuntimeService(makeStore(session) as never)
    const internals = runtime as unknown as SnapshotInternals
    const handleMaps = internals as unknown as RuntimeHandleMaps
    handleMaps.handles = makeDeadlineExhaustingMap(
      Array.from({ length: LARGE_SOURCE_SIZE }, (_, index) => [
        `handle-${index}`,
        { ptyId: `handle-pty-${index}`, leafId: `handle-leaf-${index}` }
      ]),
      (value) => {
        now = value
      }
    )
    runtime.setOrchestrationDb({
      getActiveDispatchAssignees,
      getActiveCoordinatorRun: vi.fn(() => undefined)
    } as never)
    const pty = recordSnapshotPty(internals, 'pty-third-handle-map')
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const candidate = collectSnapshotCandidate(internals, pty)

    expect(getActiveDispatchAssignees).not.toHaveBeenCalled()
    expect(candidate).toMatchObject({ hasOrchestrationOwnership: null })
    runtime.dispose()
  })

  it('stops large sleeping PTYs before orchestration and preserves nulls', () => {
    let now = 0
    const session = getDefaultWorkspaceSession()
    const getActiveDispatchAssignees = vi.fn(() => [])
    const runtime = new OrcaRuntimeService(makeStore(session) as never)
    const internals = runtime as unknown as SnapshotInternals
    const handleMaps = internals as unknown as RuntimeHandleMaps
    handleMaps.terminalSleepStateByWorktreeId = new Map([
      [
        WORKTREE_ID,
        {
          ptyIds: makeDeadlineExhaustingSet(
            Array.from({ length: LARGE_SOURCE_SIZE }, (_, index) => `sleeping-pty-${index}`),
            (value) => {
              now = value
            }
          )
        }
      ]
    ])
    runtime.setOrchestrationDb({
      getActiveDispatchAssignees,
      getActiveCoordinatorRun: vi.fn(() => undefined)
    } as never)
    const pty = recordSnapshotPty(internals, 'pty-sleeping-map')
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const candidate = collectSnapshotCandidate(internals, pty)

    expect(getActiveDispatchAssignees).not.toHaveBeenCalled()
    expect(candidate).toMatchObject({ hasOrchestrationOwnership: null })
    runtime.dispose()
  })
})
