import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getRuntimeMobileSessionSyncKey,
  hasRegisteredRuntimeTerminalTab,
  registerRuntimeTerminalTab,
  runtimeMobileSessionSyncKeysEqual,
  scheduleRuntimeGraphSync,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from './sync-runtime-graph'
import type { AppState } from '../store/types'
import type { TerminalTab } from '../../../shared/types'

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    tabsByWorktree: {},
    terminalLayoutsByTabId: {} as AppState['terminalLayoutsByTabId'],
    runtimePaneTitlesByTabId: {} as AppState['runtimePaneTitlesByTabId'],
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    layoutByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    ...overrides
  } as AppState
}

function makeTerminalTab(): TerminalTab {
  return {
    id: 'term-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function flushRuntimeGraphSyncTimer(): Promise<void> {
  await vi.advanceTimersByTimeAsync(20)
  await flushMicrotasks()
}

afterEach(() => {
  setRuntimeGraphSyncEnabled(false)
  setRuntimeGraphStoreStateGetter(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('runtime terminal registration ownership', () => {
  it('ignores stale cleanup after a replacement registers the same tab', () => {
    const first = registerRuntimeTerminalTab({
      tabId: 'term-replaced',
      worktreeId: 'wt-1',
      getManager: () => null,
      getContainer: () => null,
      getPtyIdForPane: () => null
    })
    const second = registerRuntimeTerminalTab({
      tabId: 'term-replaced',
      worktreeId: 'wt-1',
      getManager: () => null,
      getContainer: () => null,
      getPtyIdForPane: () => null
    })

    first()
    expect(hasRegisteredRuntimeTerminalTab('term-replaced')).toBe(true)

    second()
    expect(hasRegisteredRuntimeTerminalTab('term-replaced')).toBe(false)
  })
})

describe('scheduleRuntimeGraphSync', () => {
  it('publishes provenance and the monotonic used fact for mounted tabs', async () => {
    vi.useFakeTimers()
    const syncWindowGraph = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    const unregister = registerRuntimeTerminalTab({
      tabId: 'term-1',
      worktreeId: 'wt-1',
      getManager: () => null,
      getContainer: () => null,
      getPtyIdForPane: () => null
    })
    setRuntimeGraphStoreStateGetter(() =>
      makeState({
        tabsByWorktree: {
          'wt-1': [
            {
              ...makeTerminalTab(),
              creationOrigin: 'orchestration',
              hasEverReceivedExternalInput: true
            }
          ]
        } as AppState['tabsByWorktree']
      })
    )

    setRuntimeGraphSyncEnabled(true)
    await flushRuntimeGraphSyncTimer()

    expect(syncWindowGraph.mock.calls[0]?.[0].tabs).toEqual([
      expect.objectContaining({
        tabId: 'term-1',
        creationOrigin: 'orchestration',
        hasEverReceivedExternalInput: true
      })
    ])
    unregister()
  })

  it('publishes an on-screen active tab from a non-focused split group as visible', async () => {
    vi.useFakeTimers()
    const syncWindowGraph = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    const unregister = registerRuntimeTerminalTab({
      tabId: 'term-side',
      worktreeId: 'wt-1',
      getManager: () => null,
      getContainer: () => null,
      getPtyIdForPane: () => null,
      getRendererVisibility: () => 'visible'
    })
    setRuntimeGraphStoreStateGetter(() =>
      makeState({
        activeTabId: 'term-focused',
        tabsByWorktree: {
          'wt-1': [{ ...makeTerminalTab(), id: 'term-side' }]
        } as AppState['tabsByWorktree'],
        groupsByWorktree: {
          'wt-1': [
            { id: 'group-focused', activeTabId: 'focused-tab', tabOrder: ['focused-tab'] },
            { id: 'group-side', activeTabId: 'side-tab', tabOrder: ['side-tab'] }
          ]
        } as unknown as AppState['groupsByWorktree'],
        activeGroupIdByWorktree: { 'wt-1': 'group-focused' },
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'side-tab',
              groupId: 'group-side',
              contentType: 'terminal',
              entityId: 'term-side',
              title: 'Side terminal'
            }
          ]
        } as unknown as AppState['unifiedTabsByWorktree'],
        layoutByWorktree: {
          'wt-1': {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: 'group-focused' },
            second: { type: 'leaf', groupId: 'group-side' }
          }
        } as AppState['layoutByWorktree']
      })
    )

    setRuntimeGraphSyncEnabled(true)
    await flushRuntimeGraphSyncTimer()

    expect(syncWindowGraph.mock.calls[0]?.[0].tabs).toEqual([
      expect.objectContaining({ tabId: 'term-side', rendererVisibility: 'visible' })
    ])
    unregister()
  })

  it('coalesces updates that arrive while the runtime graph IPC is in flight', async () => {
    vi.useFakeTimers()
    const syncCalls: {
      promise: Promise<void>
      resolve: (value: void | PromiseLike<void>) => void
    }[] = []
    const syncWindowGraph = vi.fn(() => {
      const call = deferred<void>()
      syncCalls.push(call)
      return call.promise
    })
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    const unregister = registerRuntimeTerminalTab({
      tabId: 'term-1',
      worktreeId: 'wt-1',
      getManager: () => null,
      getContainer: () => null,
      getPtyIdForPane: () => null
    })
    setRuntimeGraphStoreStateGetter(() =>
      makeState({
        tabsByWorktree: { 'wt-1': [makeTerminalTab()] } as AppState['tabsByWorktree']
      })
    )

    setRuntimeGraphSyncEnabled(true)
    await flushRuntimeGraphSyncTimer()

    expect(syncWindowGraph).toHaveBeenCalledTimes(1)
    scheduleRuntimeGraphSync()
    scheduleRuntimeGraphSync()
    await flushRuntimeGraphSyncTimer()

    expect(syncWindowGraph).toHaveBeenCalledTimes(1)
    syncCalls[0]?.resolve()
    await flushMicrotasks()
    await flushRuntimeGraphSyncTimer()

    expect(syncWindowGraph).toHaveBeenCalledTimes(2)
    syncCalls[1]?.resolve()
    unregister()
  })

  it('coalesces updates that arrive before the frame timer fires', async () => {
    vi.useFakeTimers()
    const syncWindowGraph = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    const unregister = registerRuntimeTerminalTab({
      tabId: 'term-1',
      worktreeId: 'wt-1',
      getManager: () => null,
      getContainer: () => null,
      getPtyIdForPane: () => null
    })
    setRuntimeGraphStoreStateGetter(() =>
      makeState({
        tabsByWorktree: { 'wt-1': [makeTerminalTab()] } as AppState['tabsByWorktree']
      })
    )

    setRuntimeGraphSyncEnabled(true)
    scheduleRuntimeGraphSync()
    await flushMicrotasks()
    scheduleRuntimeGraphSync()

    expect(syncWindowGraph).toHaveBeenCalledTimes(0)
    await flushRuntimeGraphSyncTimer()

    expect(syncWindowGraph).toHaveBeenCalledTimes(1)
    unregister()
  })
})

describe('getRuntimeMobileSessionSyncKey scheduling inputs', () => {
  it('changes when only tab group split ratios change', () => {
    const base = makeState({
      layoutByWorktree: {
        'wt-1': {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-left' },
          second: { type: 'leaf', groupId: 'group-right' },
          ratio: 0.5
        }
      } as AppState['layoutByWorktree']
    })
    const baseKey = getRuntimeMobileSessionSyncKey(base)
    const resized = makeState({
      ...base,
      layoutByWorktree: {
        'wt-1': {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-left' },
          second: { type: 'leaf', groupId: 'group-right' },
          ratio: 0.65
        }
      } as AppState['layoutByWorktree']
    })

    const resizedKey = getRuntimeMobileSessionSyncKey(resized, base, baseKey)

    expect(runtimeMobileSessionSyncKeysEqual(baseKey, resizedKey)).toBe(false)
  })
})
