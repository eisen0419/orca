import { describe, expect, it, vi } from 'vitest'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree-id'
import type { WorkspaceSessionState } from '../../shared/types'
import type { IdleTerminalReclaimAmbiguityLatch } from './idle-terminal-reclaim-reconciliation-slot'
import {
  HOT_INCARNATION_ID,
  HOT_LEAF_ID,
  HOT_PANE_KEY,
  HOT_PTY_ID,
  HOT_TAB_ID,
  WORKTREE_ID,
  makeHotDirectOnlySnapshot,
  makeHotLayoutOnlySnapshot,
  makeStore
} from './idle-empty-terminal-reclaim-lifecycle-fixture'
import { OrcaRuntimeService } from './orca-runtime'

type IdleTerminalReclaimResidue =
  | { kind: 'unknown'; reasons: string[] }
  | { kind: 'present'; classes: string[] }
  | { kind: 'clear' }

type ResidueInternals = {
  graphStatus: 'unavailable' | 'reloading' | 'ready'
  mobileSessionTabsByWorktree: Map<string, unknown>
  leaves: Map<string, unknown>
  leavesByPtyId: Map<string, unknown[]>
  handleByPtyId: Map<string, string>
  handleByLeafKey: Map<string, string>
  handles: Map<string, unknown>
  waitersByHandle: Map<string, Set<unknown>>
  detachedPreAllocatedLeaves: Map<string, unknown>
  headlessTerminals: Map<string, unknown>
  headlessHydrationState: Map<string, 'pending' | 'done'>
  ptysById: Map<string, unknown>
  reclaimInFlightByPtyId: Map<string, unknown>
  headlessTerminalArchiveByOperationId: Map<string, Promise<string>>
  terminalSleepByWorktreeId: Map<string, Promise<unknown>>
  terminalMutationTailByWorktreeId: Map<string, Promise<void>>
  terminalSleepStateByWorktreeId: Map<string, unknown>
  terminalPaneRecoveryByIdentity: Map<string, Promise<unknown>>
  idleTerminalReclaimReservationOrLatch: {
    kind: 'ambiguity-latch'
    latch: IdleTerminalReclaimAmbiguityLatch
  } | null
  collectIdleTerminalReclaimResidue: (
    latch: IdleTerminalReclaimAmbiguityLatch
  ) => IdleTerminalReclaimResidue
  releaseIdleTerminalReclaimAmbiguityLatchWhenNaturallyCleared: () => void
}

type ResidueHarness = {
  runtime: OrcaRuntimeService
  internals: ResidueInternals
  session: WorkspaceSessionState
  latch: IdleTerminalReclaimAmbiguityLatch
  setHasPty: (hasPty: (ptyId: string) => boolean | null) => void
  store: ReturnType<typeof makeStore>
}

type CarrierMutation = {
  name: string
  expectedClasses: string[]
  apply: (
    harness: ResidueHarness
  ) => (() => void | Promise<void>) | Promise<() => void | Promise<void>>
}

function normalizedWorktreeKey(worktreeId: string): string {
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  return parsed
    ? `${parsed.repoId}\0${normalizeRuntimePathForComparison(parsed.worktreePath)}`
    : worktreeId
}

function createLatch(ptyId = HOT_PTY_ID): IdleTerminalReclaimAmbiguityLatch {
  return {
    mode: 'hot-only',
    claimIncarnationId: HOT_INCARNATION_ID,
    worktreeId: WORKTREE_ID,
    tabId: HOT_TAB_ID,
    leafId: HOT_LEAF_ID,
    ptyId,
    ownerKind: 'hot-only',
    capturedTopologyRevision: null,
    createdAt: 0,
    reason: 'post-stop-identity-null'
  }
}

function terminalTab(ptyId: string | null) {
  return {
    id: HOT_TAB_ID,
    ptyId,
    worktreeId: WORKTREE_ID,
    title: 'Background shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function createResidueHarness(
  options: { ptyId?: string; session?: WorkspaceSessionState } = {}
): ResidueHarness {
  const session = options.session ?? getDefaultWorkspaceSession()
  const store = makeStore(session)
  const runtime = new OrcaRuntimeService(store as never)
  const internals = runtime as unknown as ResidueInternals
  const latch = createLatch(options.ptyId)
  const setHasPty = (hasPty: (ptyId: string) => boolean | null): void => {
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => 'zsh'),
      hasPty
    })
  }
  internals.graphStatus = 'ready'
  setHasPty(() => false)
  return { runtime, internals, session, latch, setHasPty, store }
}

const carrierMutations: readonly CarrierMutation[] = [
  {
    name: 'provider liveness',
    expectedClasses: ['provider-pty'],
    apply: (harness) => {
      harness.setHasPty(() => true)
      return () => harness.setHasPty(() => false)
    }
  },
  {
    name: 'SSH restorable lease',
    expectedClasses: ['ssh-restorable-lease'],
    apply: (harness) => {
      const ptyId = 'ssh:target-1@@relay-pty'
      harness.latch.ptyId = ptyId
      ;(harness.store as { getSshRemotePtyLeases?: () => unknown[] }).getSshRemotePtyLeases =
        () => [
          {
            targetId: 'target-1',
            ptyId: 'relay-pty',
            worktreeId: WORKTREE_ID,
            tabId: HOT_TAB_ID,
            leafId: HOT_LEAF_ID,
            state: 'attached'
          }
        ]
      return () => {
        ;(harness.store as { getSshRemotePtyLeases?: () => unknown[] }).getSshRemotePtyLeases =
          () => []
      }
    }
  },
  {
    name: 'durable tab pty',
    expectedClasses: ['durable-tab-pty'],
    apply: (harness) => {
      harness.session.tabsByWorktree[WORKTREE_ID] = [terminalTab(HOT_PTY_ID)]
      return () => {
        harness.session.tabsByWorktree[WORKTREE_ID] = []
      }
    }
  },
  {
    name: 'durable layout pty',
    expectedClasses: ['durable-layout-pty'],
    apply: (harness) => {
      harness.session.tabsByWorktree[WORKTREE_ID] = [terminalTab(null)]
      harness.session.terminalLayoutsByTabId[HOT_TAB_ID] = {
        root: { type: 'leaf', leafId: HOT_LEAF_ID },
        activeLeafId: HOT_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [HOT_LEAF_ID]: HOT_PTY_ID }
      }
      return () => {
        harness.session.tabsByWorktree[WORKTREE_ID] = []
        delete harness.session.terminalLayoutsByTabId[HOT_TAB_ID]
      }
    }
  },
  {
    name: 'durable remote-session pty',
    expectedClasses: ['durable-remote-session-pty'],
    apply: (harness) => {
      harness.session.tabsByWorktree[WORKTREE_ID] = [terminalTab(null)]
      harness.session.remoteSessionIdsByTabId = { [HOT_TAB_ID]: HOT_PTY_ID }
      return () => {
        harness.session.tabsByWorktree[WORKTREE_ID] = []
        harness.session.remoteSessionIdsByTabId = {}
      }
    }
  },
  {
    name: 'durable pane incarnation',
    expectedClasses: ['durable-pane-incarnation'],
    apply: (harness) => {
      harness.session.terminalPtyIncarnationsByPaneKey = { [HOT_PANE_KEY]: HOT_INCARNATION_ID }
      return () => {
        harness.session.terminalPtyIncarnationsByPaneKey = {}
      }
    }
  },
  {
    name: 'mobile direct pty',
    expectedClasses: ['mobile-session-direct-pty'],
    apply: (harness) => {
      harness.internals.mobileSessionTabsByWorktree.set(WORKTREE_ID, makeHotDirectOnlySnapshot())
      return () => harness.internals.mobileSessionTabsByWorktree.clear()
    }
  },
  {
    name: 'mobile layout pty',
    expectedClasses: ['mobile-session-layout-pty'],
    apply: (harness) => {
      harness.internals.mobileSessionTabsByWorktree.set(WORKTREE_ID, makeHotLayoutOnlySnapshot())
      return () => harness.internals.mobileSessionTabsByWorktree.clear()
    }
  },
  {
    name: 'renderer exact leaf',
    expectedClasses: ['renderer-leaf'],
    apply: (harness) => {
      harness.internals.leaves.set(`${HOT_TAB_ID}::${HOT_LEAF_ID}`, {
        tabId: HOT_TAB_ID,
        leafId: HOT_LEAF_ID,
        worktreeId: WORKTREE_ID,
        ptyId: HOT_PTY_ID
      })
      return () => harness.internals.leaves.clear()
    }
  },
  {
    name: 'renderer pty leaf index',
    expectedClasses: ['renderer-leaves-by-pty'],
    apply: (harness) => {
      harness.internals.leavesByPtyId.set(HOT_PTY_ID, [
        {
          tabId: HOT_TAB_ID,
          leafId: HOT_LEAF_ID,
          worktreeId: WORKTREE_ID,
          ptyId: HOT_PTY_ID
        }
      ])
      return () => harness.internals.leavesByPtyId.clear()
    }
  },
  {
    name: 'detached leaf',
    expectedClasses: ['detached-leaf'],
    apply: (harness) => {
      harness.internals.detachedPreAllocatedLeaves.set(HOT_PTY_ID, {
        tabId: HOT_TAB_ID,
        leafId: HOT_LEAF_ID,
        worktreeId: WORKTREE_ID,
        ptyId: HOT_PTY_ID
      })
      return () => harness.internals.detachedPreAllocatedLeaves.clear()
    }
  },
  {
    name: 'headless terminal',
    expectedClasses: ['headless-terminal'],
    apply: (harness) => {
      harness.internals.headlessTerminals.set(HOT_PTY_ID, {})
      return () => harness.internals.headlessTerminals.clear()
    }
  },
  {
    name: 'headless hydration',
    expectedClasses: ['headless-hydration'],
    apply: (harness) => {
      harness.internals.headlessHydrationState.set(HOT_PTY_ID, 'pending')
      return () => harness.internals.headlessHydrationState.clear()
    }
  },
  {
    name: 'runtime PTY record',
    expectedClasses: ['pty-runtime-record'],
    apply: (harness) => {
      harness.internals.ptysById.set(HOT_PTY_ID, { incarnationId: HOT_INCARNATION_ID })
      return () => harness.internals.ptysById.clear()
    }
  },
  {
    name: 'reclaim in flight',
    expectedClasses: ['reclaim-in-flight'],
    apply: (harness) => {
      harness.internals.reclaimInFlightByPtyId.set(HOT_PTY_ID, {})
      return () => harness.internals.reclaimInFlightByPtyId.clear()
    }
  },
  {
    name: 'headless archive transaction',
    expectedClasses: ['headless-archive-transaction'],
    apply: (harness) => {
      harness.internals.headlessTerminalArchiveByOperationId.set(
        `user-close:${HOT_TAB_ID}:fixture`,
        Promise.resolve('archive')
      )
      return () => harness.internals.headlessTerminalArchiveByOperationId.clear()
    }
  },
  {
    name: 'worktree sleep transaction',
    expectedClasses: ['worktree-terminal-sleep'],
    apply: (harness) => {
      harness.internals.terminalSleepByWorktreeId.set(WORKTREE_ID, Promise.resolve({}))
      return () => harness.internals.terminalSleepByWorktreeId.clear()
    }
  },
  {
    name: 'worktree mutation transaction',
    expectedClasses: ['worktree-terminal-mutation'],
    apply: (harness) => {
      harness.internals.terminalMutationTailByWorktreeId.set(
        normalizedWorktreeKey(WORKTREE_ID),
        Promise.resolve()
      )
      return () => harness.internals.terminalMutationTailByWorktreeId.clear()
    }
  },
  {
    name: 'worktree sleep-state transaction',
    expectedClasses: ['worktree-terminal-sleep-state'],
    apply: (harness) => {
      harness.internals.terminalSleepStateByWorktreeId.set(normalizedWorktreeKey(WORKTREE_ID), {
        ptyIds: [HOT_PTY_ID],
        terminalHandlesByPtyId: {}
      })
      return () => harness.internals.terminalSleepStateByWorktreeId.clear()
    }
  },
  {
    name: 'pane recovery transaction',
    expectedClasses: ['terminal-pane-recovery'],
    apply: (harness) => {
      harness.internals.terminalPaneRecoveryByIdentity.set(
        `${WORKTREE_ID}\0${HOT_PANE_KEY}`,
        Promise.resolve({})
      )
      return () => harness.internals.terminalPaneRecoveryByIdentity.clear()
    }
  }
]

describe('idle terminal reclaim residue scanner', () => {
  it('returns clear only when no carrier remains', () => {
    const harness = createResidueHarness()

    expect(harness.internals.collectIdleTerminalReclaimResidue(harness.latch)).toEqual({
      kind: 'clear'
    })

    harness.runtime.dispose()
  })

  it.each(carrierMutations)(
    'holds for the isolated $name carrier and clears after it naturally disappears',
    async ({ apply, expectedClasses }) => {
      const harness = createResidueHarness()
      const cleanup = await apply(harness)

      expect(harness.internals.collectIdleTerminalReclaimResidue(harness.latch)).toEqual({
        kind: 'present',
        classes: expectedClasses
      })

      await cleanup()

      expect(harness.internals.collectIdleTerminalReclaimResidue(harness.latch)).toEqual({
        kind: 'clear'
      })
      harness.runtime.dispose()
    }
  )

  it('ignores a different renderer tuple under the same PTY index key', () => {
    const harness = createResidueHarness()
    harness.internals.leavesByPtyId.set(HOT_PTY_ID, [
      {
        tabId: 'replacement-tab',
        leafId: 'replacement-leaf',
        worktreeId: WORKTREE_ID,
        ptyId: HOT_PTY_ID
      }
    ])

    expect(harness.internals.collectIdleTerminalReclaimResidue(harness.latch)).toEqual({
      kind: 'clear'
    })
    harness.runtime.dispose()
  })

  it.each([
    {
      name: 'PTY alias',
      expectedClasses: ['pty-handle-alias'],
      apply: (harness: ResidueHarness) => {
        harness.internals.handleByPtyId.set(HOT_PTY_ID, 'term-pty-alias')
      }
    },
    {
      name: 'leaf alias',
      expectedClasses: ['leaf-handle-alias', 'terminal-handle'],
      apply: (harness: ResidueHarness) => {
        harness.internals.handleByLeafKey.set(`${HOT_TAB_ID}::${HOT_LEAF_ID}`, 'term-leaf-alias')
        harness.internals.handles.set('term-leaf-alias', { ptyId: HOT_PTY_ID })
      }
    },
    {
      name: 'orphan matching handle',
      expectedClasses: ['terminal-handle'],
      apply: (harness: ResidueHarness) => {
        harness.internals.handles.set('term-orphan', { ptyId: HOT_PTY_ID })
      }
    }
  ])('reports the exact class for a $name', ({ apply, expectedClasses }) => {
    const harness = createResidueHarness()
    apply(harness)

    expect(harness.internals.collectIdleTerminalReclaimResidue(harness.latch)).toEqual({
      kind: 'present',
      classes: expectedClasses
    })
    harness.runtime.dispose()
  })

  it.each([
    {
      name: 'PTY alias',
      expectedClasses: ['pty-handle-alias', 'terminal-handle-waiter'],
      apply: (harness: ResidueHarness) => {
        harness.internals.handleByPtyId.set(HOT_PTY_ID, 'term-pty-alias')
        harness.internals.waitersByHandle.set('term-pty-alias', new Set([{}]))
      }
    },
    {
      name: 'leaf alias',
      expectedClasses: ['leaf-handle-alias', 'terminal-handle', 'terminal-handle-waiter'],
      apply: (harness: ResidueHarness) => {
        harness.internals.handleByLeafKey.set(`${HOT_TAB_ID}::${HOT_LEAF_ID}`, 'term-leaf-alias')
        harness.internals.handles.set('term-leaf-alias', { ptyId: HOT_PTY_ID })
        harness.internals.waitersByHandle.set('term-leaf-alias', new Set([{}]))
      }
    },
    {
      name: 'orphan matching handle',
      expectedClasses: ['terminal-handle', 'terminal-handle-waiter'],
      apply: (harness: ResidueHarness) => {
        harness.internals.handles.set('term-orphan', { ptyId: HOT_PTY_ID })
        harness.internals.waitersByHandle.set('term-orphan', new Set([{}]))
      }
    }
  ])('reports a waiter for each matching $name', ({ apply, expectedClasses }) => {
    const harness = createResidueHarness()
    apply(harness)

    expect(harness.internals.collectIdleTerminalReclaimResidue(harness.latch)).toEqual({
      kind: 'present',
      classes: expectedClasses
    })
    harness.runtime.dispose()
  })

  it.each([
    ['provider returns null', (harness: ResidueHarness) => harness.setHasPty(() => null)],
    [
      'provider throws',
      (harness: ResidueHarness) =>
        harness.setHasPty(() => {
          throw new Error('provider unavailable')
        })
    ],
    [
      'renderer graph is not ready',
      (harness: ResidueHarness) => (harness.internals.graphStatus = 'reloading')
    ]
  ])('returns unknown when %s', (_name, mutate) => {
    const harness = createResidueHarness()
    mutate(harness)

    expect(harness.internals.collectIdleTerminalReclaimResidue(harness.latch)).toMatchObject({
      kind: 'unknown'
    })
    harness.runtime.dispose()
  })

  it('holds an SSH latch as unknown when its lease store cannot be read', () => {
    const harness = createResidueHarness({ ptyId: 'ssh:target-1@@relay-pty' })

    expect(harness.internals.collectIdleTerminalReclaimResidue(harness.latch)).toMatchObject({
      kind: 'unknown'
    })
    harness.runtime.dispose()
  })

  it('keeps an ambiguity latch for present or unknown residue and releases only for clear', () => {
    const held = createResidueHarness()
    held.internals.idleTerminalReclaimReservationOrLatch = {
      kind: 'ambiguity-latch',
      latch: held.latch
    }
    held.setHasPty(() => true)
    held.internals.releaseIdleTerminalReclaimAmbiguityLatchWhenNaturallyCleared()

    expect(held.internals.idleTerminalReclaimReservationOrLatch).not.toBeNull()
    held.setHasPty(() => false)
    held.internals.releaseIdleTerminalReclaimAmbiguityLatchWhenNaturallyCleared()
    expect(held.internals.idleTerminalReclaimReservationOrLatch).toBeNull()
    held.runtime.dispose()

    const unknown = createResidueHarness()
    unknown.internals.idleTerminalReclaimReservationOrLatch = {
      kind: 'ambiguity-latch',
      latch: unknown.latch
    }
    unknown.internals.graphStatus = 'unavailable'
    unknown.internals.releaseIdleTerminalReclaimAmbiguityLatchWhenNaturallyCleared()

    expect(unknown.internals.idleTerminalReclaimReservationOrLatch).not.toBeNull()
    unknown.runtime.dispose()
  })
})
