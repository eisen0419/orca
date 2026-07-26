import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { TerminalTab, WorkspaceSessionState } from '../../shared/types'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE_ID = 'worktree-1'
const SECOND_WORKTREE_ID = 'worktree-2'
const OTHER_WORKTREE_ID = 'worktree-other'
const HOT_TAB_ID = '55555555-5555-4555-8555-555555555555'
const HOT_LEAF_ID = '66666666-6666-4666-8666-666666666666'

type RuntimeIdleReclaimInternals = {
  collectIdleEmptyTerminalReclaimCandidates: () => Promise<
    {
      ptyId: string | null
      isPersisted: boolean | null
      rendererOwnsPersistedTab: boolean | null
    }[]
  >
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean; incarnationId?: string; tabId?: string; paneKey?: string }
  ) => { creationOrigin: 'user' | 'cli' | 'orchestration' | null }
  graphStatus: 'unavailable' | 'reloading' | 'ready'
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

function persistedTerminalTab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: OTHER_WORKTREE_ID,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    creationOrigin: 'cli'
  }
}

function configureDeferredInspection(
  runtime: OrcaRuntimeService,
  inspections: ((value: { foregroundProcess: string; hasChildProcesses: boolean }) => void)[]
) {
  runtime.setPtyController({
    spawn: vi.fn(),
    write: vi.fn(() => true),
    kill: vi.fn(() => true),
    getForegroundProcess: vi.fn(async () => 'zsh'),
    inspectProcess: vi.fn(
      () =>
        new Promise<{ foregroundProcess: string; hasChildProcesses: boolean }>((resolve) => {
          inspections.push(resolve)
        })
    )
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OrcaRuntimeService idle empty-terminal reclaim live ownership', () => {
  it('builds one fresh persisted-binding index for multiple candidates in the same session', async () => {
    let persistedTabIdReads = 0
    const session = getDefaultWorkspaceSession()
    session.tabsByWorktree[WORKTREE_ID] = []
    session.tabsByWorktree[OTHER_WORKTREE_ID] = Array.from({ length: 64 }, (_, index) => {
      const tab = persistedTerminalTab(`other-persisted-tab-${index}`)
      Object.defineProperty(tab, 'id', {
        enumerable: true,
        get: () => {
          persistedTabIdReads += 1
          return `other-persisted-tab-${index}`
        }
      })
      return tab
    })
    const runtime = new OrcaRuntimeService(makeStore(session) as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    internals.graphStatus = 'ready'
    const inspections: ((value: {
      foregroundProcess: string
      hasChildProcesses: boolean
    }) => void)[] = []
    configureDeferredInspection(runtime, inspections)
    for (const ptyId of ['pty-first', 'pty-second']) {
      const pty = internals.recordPtyWorktree(ptyId, WORKTREE_ID, {
        connected: true,
        incarnationId: `${ptyId}-incarnation`,
        tabId: HOT_TAB_ID,
        paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
      })
      pty.creationOrigin = 'cli'
    }

    const pendingCandidates = internals.collectIdleEmptyTerminalReclaimCandidates()
    await vi.waitFor(() => expect(inspections).toHaveLength(2))
    persistedTabIdReads = 0
    for (const resolve of inspections) {
      resolve({ foregroundProcess: 'zsh', hasChildProcesses: false })
    }
    const candidates = await pendingCandidates

    expect(persistedTabIdReads).toBe(256)
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ptyId: 'pty-first', isPersisted: false }),
        expect.objectContaining({ ptyId: 'pty-second', isPersisted: false })
      ])
    )
    runtime.dispose()
  })

  it('nulls ownership for candidates left outside the shared post-inspection budget', async () => {
    let now = 0
    let dateCalls = 0
    const session = getDefaultWorkspaceSession()
    session.tabsByWorktree[WORKTREE_ID] = []
    session.tabsByWorktree[SECOND_WORKTREE_ID] = []
    const runtime = new OrcaRuntimeService(makeStore(session) as never)
    const internals = runtime as unknown as RuntimeIdleReclaimInternals
    internals.graphStatus = 'ready'
    const inspections: ((value: {
      foregroundProcess: string
      hasChildProcesses: boolean
    }) => void)[] = []
    configureDeferredInspection(runtime, inspections)
    for (const [ptyId, worktreeId] of [
      ['pty-served', WORKTREE_ID],
      ['pty-unserved', SECOND_WORKTREE_ID]
    ] as const) {
      const pty = internals.recordPtyWorktree(ptyId, worktreeId, {
        connected: true,
        incarnationId: `${ptyId}-incarnation`,
        tabId: HOT_TAB_ID,
        paneKey: `${HOT_TAB_ID}:${HOT_LEAF_ID}`
      })
      pty.creationOrigin = 'cli'
    }

    const pendingCandidates = internals.collectIdleEmptyTerminalReclaimCandidates()
    await vi.waitFor(() => expect(inspections).toHaveLength(2))
    vi.spyOn(Date, 'now').mockImplementation(() => {
      dateCalls += 1
      now = dateCalls >= 5 ? 50 : 0
      return now
    })
    for (const resolve of inspections) {
      resolve({ foregroundProcess: 'zsh', hasChildProcesses: false })
    }
    const candidates = await pendingCandidates

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ptyId: 'pty-served',
          isPersisted: false,
          rendererOwnsPersistedTab: false
        }),
        expect.objectContaining({
          ptyId: 'pty-unserved',
          isPersisted: null,
          rendererOwnsPersistedTab: null
        })
      ])
    )
    runtime.dispose()
  })
})
