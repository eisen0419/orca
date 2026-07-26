export const IDLE_EMPTY_TERMINAL_RECLAIM_SCAN_INTERVAL_MS = 60_000

const INITIAL_RETRY_DELAY_MS = 1_000
const MAX_RETRY_DELAY_MS = 60_000

type ScheduledTimer = ReturnType<typeof setTimeout>

export type IdleEmptyTerminalReclaimSchedule = (
  callback: () => void,
  delay: number
) => ScheduledTimer

export type IdleEmptyTerminalReclaimCancel = (timer: ScheduledTimer) => void

export type IdleEmptyTerminalReclaimSchedulerOptions = {
  now?: () => number
  schedule?: IdleEmptyTerminalReclaimSchedule
  cancel?: IdleEmptyTerminalReclaimCancel
}

function scheduleTimer(callback: () => void, delay: number): ScheduledTimer {
  return setTimeout(callback, delay)
}

function cancelTimer(timer: ScheduledTimer): void {
  clearTimeout(timer)
}

export class IdleEmptyTerminalReclaimScheduler {
  private timer: ScheduledTimer | null = null
  private disposed = false
  private tickInFlight = false
  private retryDelayMs = INITIAL_RETRY_DELAY_MS
  private timerGeneration = 0
  private readonly now: () => number
  private readonly schedule: IdleEmptyTerminalReclaimSchedule
  private readonly cancel: IdleEmptyTerminalReclaimCancel

  constructor(
    private readonly tick: () => Promise<void>,
    options: IdleEmptyTerminalReclaimSchedulerOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? scheduleTimer
    this.cancel = options.cancel ?? cancelTimer
  }

  start(): void {
    if (this.disposed || this.timer) {
      return
    }
    this.scheduleAfter(IDLE_EMPTY_TERMINAL_RECLAIM_SCAN_INTERVAL_MS)
  }

  reset(): void {
    if (this.disposed) {
      return
    }
    this.clearScheduledTimer()
    this.scheduleAfter(IDLE_EMPTY_TERMINAL_RECLAIM_SCAN_INTERVAL_MS)
  }

  dispose(): void {
    this.disposed = true
    this.clearScheduledTimer()
  }

  private scheduleAfter(delay: number): void {
    this.scheduleAt(this.now() + delay)
  }

  private scheduleAt(runAt: number): void {
    if (this.disposed) {
      return
    }
    const generation = ++this.timerGeneration
    const delay = Math.max(0, runAt - this.now())
    const timer = this.schedule(() => {
      if (this.disposed || generation !== this.timerGeneration) {
        return
      }
      this.timer = null
      this.runTick()
    }, delay)
    this.timer = timer
    this.timer.unref?.()
  }

  private clearScheduledTimer(): void {
    this.timerGeneration += 1
    if (!this.timer) {
      return
    }
    this.cancel(this.timer)
    this.timer = null
  }

  private runTick(): void {
    if (this.disposed) {
      return
    }
    this.scheduleAfter(IDLE_EMPTY_TERMINAL_RECLAIM_SCAN_INTERVAL_MS)
    if (this.tickInFlight) {
      return
    }
    this.tickInFlight = true
    try {
      void this.tick().then(
        () => this.handleTickSuccess(),
        () => this.handleTickFailure()
      )
    } catch {
      this.handleTickFailure()
    }
  }

  private handleTickSuccess(): void {
    this.tickInFlight = false
    this.retryDelayMs = INITIAL_RETRY_DELAY_MS
  }

  private handleTickFailure(): void {
    this.tickInFlight = false
    if (this.disposed) {
      return
    }
    this.clearScheduledTimer()
    const retryDelay = this.retryDelayMs
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_DELAY_MS)
    this.scheduleAfter(retryDelay)
  }
}
