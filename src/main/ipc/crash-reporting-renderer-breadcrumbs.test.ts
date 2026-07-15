import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  listeners,
  recordCoalescedCrashBreadcrumbMock,
  recordCrashBreadcrumbMock,
  spanEndMock,
  startSpanMock
} = vi.hoisted(() => {
  const spanEndMock = vi.fn()
  return {
    listeners: new Map<string, (_event: unknown, args?: unknown) => void>(),
    recordCoalescedCrashBreadcrumbMock: vi.fn(),
    recordCrashBreadcrumbMock: vi.fn(),
    spanEndMock,
    startSpanMock: vi.fn(() => ({
      traceId: 'trace-id',
      spanId: 'span-id',
      setAttribute: vi.fn(),
      addEvent: vi.fn(),
      fail: vi.fn(),
      interrupt: vi.fn(),
      end: spanEndMock
    }))
  }
})

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test' },
  clipboard: { writeText: vi.fn() },
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(),
    removeAllListeners: vi.fn((channel: string) => listeners.delete(channel)),
    on: vi.fn((channel: string, listener: (_event: unknown, args?: unknown) => void) => {
      listeners.set(channel, listener)
    })
  }
}))

vi.mock('./feedback', () => ({
  submitFeedback: vi.fn()
}))

vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({
  getCrashBreadcrumbSnapshot: vi.fn(() => []),
  recordCoalescedCrashBreadcrumb: (...args: unknown[]) =>
    recordCoalescedCrashBreadcrumbMock(...args),
  recordCrashBreadcrumb: (...args: unknown[]) => recordCrashBreadcrumbMock(...args)
}))

vi.mock('../observability', () => ({
  collectDiagnosticBundle: vi.fn(),
  getDiagnosticsStatus: vi.fn()
}))

vi.mock('../observability/diagnostic-upload-endpoint', () => ({
  resolveDiagnosticOrcaChannel: vi.fn()
}))

vi.mock('../observability/tracer', () => ({
  startSpan: startSpanMock
}))

import { registerCrashReportingHandlers } from './crash-reporting'

function registerHandlersWithStubStore(): void {
  registerCrashReportingHandlers({
    getLatestPending: vi.fn(),
    getById: vi.fn(),
    dismiss: vi.fn(),
    markSent: vi.fn(),
    listRecent: vi.fn(),
    record: vi.fn(),
    formatDiagnosticText: vi.fn()
  } as never)
}

function emitRendererBreadcrumb(args: unknown): void {
  listeners.get('crashReports:recordBreadcrumb')?.(null, args)
}

describe('renderer breadcrumb IPC routing', () => {
  beforeEach(() => {
    listeners.clear()
    recordCoalescedCrashBreadcrumbMock.mockReset()
    recordCrashBreadcrumbMock.mockReset()
    startSpanMock.mockClear()
    spanEndMock.mockClear()
    registerHandlersWithStubStore()
  })

  it('sanitizes and coalesces renderer error breadcrumbs', () => {
    emitRendererBreadcrumb({
      name: 'renderer_error',
      data: {
        message: 'boom',
        count: 2,
        ok: true,
        empty: null,
        badNumber: Number.POSITIVE_INFINITY,
        object: { ignored: true }
      }
    })

    expect(recordCoalescedCrashBreadcrumbMock).toHaveBeenCalledWith({
      name: 'renderer_error',
      data: { message: 'boom', count: 2, ok: true, empty: null },
      coalesceKey: 'renderer_error:boom',
      minIntervalMs: 30_000
    })
    expect(recordCrashBreadcrumbMock).not.toHaveBeenCalled()
    expect(startSpanMock).toHaveBeenCalledWith('renderer.breadcrumb', {
      attributes: {
        kind: 'crash-breadcrumb',
        'breadcrumb.name': 'renderer_error',
        'breadcrumb.data': { message: 'boom', count: 2, ok: true, empty: null }
      }
    })
    expect(spanEndMock).toHaveBeenCalledTimes(1)
  })

  it('coalesces renderer rejection breadcrumbs by reason message', () => {
    emitRendererBreadcrumb({
      name: 'renderer_unhandled_rejection',
      data: { reasonType: 'string', reasonMessage: 'Remote connection dropped/reconnecting' }
    })

    expect(recordCoalescedCrashBreadcrumbMock).toHaveBeenCalledWith({
      name: 'renderer_unhandled_rejection',
      data: { reasonType: 'string', reasonMessage: 'Remote connection dropped/reconnecting' },
      coalesceKey: 'renderer_unhandled_rejection:Remote connection dropped/reconnecting',
      minIntervalMs: 30_000
    })
    expect(recordCrashBreadcrumbMock).not.toHaveBeenCalled()
  })

  it('records non-error renderer breadcrumbs without coalescing', () => {
    emitRendererBreadcrumb({ name: 'renderer_bootstrap_started', data: { dev: true } })

    expect(recordCrashBreadcrumbMock).toHaveBeenCalledWith('renderer_bootstrap_started', {
      dev: true
    })
    expect(recordCoalescedCrashBreadcrumbMock).not.toHaveBeenCalled()
  })

  it('ignores renderer breadcrumbs without a string name', () => {
    emitRendererBreadcrumb({ name: 123, data: { message: 'boom' } })

    expect(recordCrashBreadcrumbMock).not.toHaveBeenCalled()
    expect(recordCoalescedCrashBreadcrumbMock).not.toHaveBeenCalled()
    expect(startSpanMock).not.toHaveBeenCalled()
  })
})
