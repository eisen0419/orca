import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IDLE_EMPTY_TERMINAL_RECLAIM_SCAN_INTERVAL_MS,
  IdleEmptyTerminalReclaimScheduler
} from './idle-empty-terminal-reclaim-scheduler'

afterEach(() => {
  vi.useRealTimers()
})

describe('IdleEmptyTerminalReclaimScheduler', () => {
  it('runs on a fixed 60 second cadence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const tick = vi.fn(async () => {})
    const scheduler = new IdleEmptyTerminalReclaimScheduler(tick)

    scheduler.start()
    await vi.advanceTimersByTimeAsync(IDLE_EMPTY_TERMINAL_RECLAIM_SCAN_INTERVAL_MS - 1)
    expect(tick).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(tick).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(IDLE_EMPTY_TERMINAL_RECLAIM_SCAN_INTERVAL_MS)
    expect(tick).toHaveBeenCalledTimes(2)

    scheduler.dispose()
  })

  it('coalesces periods while a slow tick is still running', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let releaseFirstTick!: () => void
    const firstTick = new Promise<void>((resolve) => {
      releaseFirstTick = resolve
    })
    const tick = vi.fn(() => firstTick)
    const scheduler = new IdleEmptyTerminalReclaimScheduler(tick)

    scheduler.start()
    await vi.advanceTimersByTimeAsync(IDLE_EMPTY_TERMINAL_RECLAIM_SCAN_INTERVAL_MS)
    expect(tick).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(IDLE_EMPTY_TERMINAL_RECLAIM_SCAN_INTERVAL_MS * 2)
    expect(tick).toHaveBeenCalledTimes(1)

    releaseFirstTick()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(IDLE_EMPTY_TERMINAL_RECLAIM_SCAN_INTERVAL_MS)
    expect(tick).toHaveBeenCalledTimes(2)

    scheduler.dispose()
  })

  it('uses an exponential retry backoff after rejected ticks', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const tick = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockResolvedValue(undefined)
    const scheduler = new IdleEmptyTerminalReclaimScheduler(tick)

    scheduler.start()
    await vi.advanceTimersByTimeAsync(IDLE_EMPTY_TERMINAL_RECLAIM_SCAN_INTERVAL_MS)
    expect(tick).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(tick).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1_999)
    expect(tick).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(tick).toHaveBeenCalledTimes(3)

    scheduler.dispose()
  })

  it('unrefs injected timers and honors reset scheduling from the injected clock', async () => {
    const unref = vi.fn()
    const cancel = vi.fn()
    const scheduled: { callback: () => void; delay: number }[] = []
    let currentTime = 500
    const scheduler = new IdleEmptyTerminalReclaimScheduler(async () => {}, {
      now: () => currentTime,
      schedule: (callback, delay) => {
        scheduled.push({ callback, delay })
        return { unref } as unknown as ReturnType<typeof setTimeout>
      },
      cancel
    })

    scheduler.start()
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0].delay).toBe(IDLE_EMPTY_TERMINAL_RECLAIM_SCAN_INTERVAL_MS)
    expect(unref).toHaveBeenCalledTimes(1)

    currentTime += IDLE_EMPTY_TERMINAL_RECLAIM_SCAN_INTERVAL_MS
    scheduled[0].callback()
    await Promise.resolve()
    expect(scheduled[1].delay).toBe(IDLE_EMPTY_TERMINAL_RECLAIM_SCAN_INTERVAL_MS)

    scheduler.reset()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(scheduled[2].delay).toBe(IDLE_EMPTY_TERMINAL_RECLAIM_SCAN_INTERVAL_MS)
    scheduler.dispose()
  })

  it('stops its timer on dispose without leaking a pending scan', async () => {
    vi.useFakeTimers()
    const tick = vi.fn(async () => {})
    const scheduler = new IdleEmptyTerminalReclaimScheduler(tick)

    scheduler.start()
    scheduler.dispose()
    await vi.advanceTimersByTimeAsync(IDLE_EMPTY_TERMINAL_RECLAIM_SCAN_INTERVAL_MS * 2)

    expect(tick).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
