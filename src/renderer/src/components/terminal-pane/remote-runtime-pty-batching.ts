import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES,
  getTerminalInputByteLength,
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks
} from '../../../../shared/terminal-input'

export type RemoteRuntimePtyBatcher = {
  push: (data: string, inputKind?: RemoteRuntimePtyInputKind) => boolean
  drain: () => Promise<void>
  takePending: () => string
  flush: () => void
  clear: () => void
}

export type RemoteRuntimePtyInputKind = 'external' | 'query-reply'

export type RemoteRuntimeViewportBatcher = {
  queue: (cols: number, rows: number) => void
  flush: () => void
  clear: () => void
}

export type RemoteRuntimePtyTextBatcherOptions = {
  maxPendingBytes?: number
  maxBytes?: number
  maxValidationQueuedCodeUnits?: number
  maxValidationQueuedEntries?: number
}

export const REMOTE_RUNTIME_PTY_VALIDATION_QUEUE_MAX_ENTRIES = 4_096

export function createRemoteRuntimePtyTextBatcher(
  delayMs: number,
  onFlush: (text: string, inputKind: RemoteRuntimePtyInputKind) => unknown,
  options: RemoteRuntimePtyTextBatcherOptions = {}
): RemoteRuntimePtyBatcher {
  const maxPendingBytes = getPositiveByteLimit(
    options.maxPendingBytes,
    TERMINAL_INPUT_CHUNK_MAX_BYTES
  )
  const maxBytes = getPositiveByteLimit(options.maxBytes, TERMINAL_INPUT_MAX_BYTES)
  const maxValidationQueuedCodeUnits = getPositiveByteLimit(
    options.maxValidationQueuedCodeUnits,
    maxBytes
  )
  const maxValidationQueuedEntries = getPositiveByteLimit(
    options.maxValidationQueuedEntries,
    REMOTE_RUNTIME_PTY_VALIDATION_QUEUE_MAX_ENTRIES
  )
  let pending: { text: string; inputKind: RemoteRuntimePtyInputKind }[] = []
  let pendingBytes = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let flushRequestedWhileInFlight = false
  let pendingVersion = 0
  let validationTail: Promise<void> | null = null
  let validationVersion = 0
  let validationQueuedCodeUnits = 0
  let validationQueuedEntries = 0

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const clear = (): void => {
    clearTimer()
    pending = []
    pendingBytes = 0
    pendingVersion += 1
    flushRequestedWhileInFlight = false
    validationVersion += 1
    validationTail = null
    validationQueuedCodeUnits = 0
    validationQueuedEntries = 0
  }

  const flush = (): void => {
    clearTimer()
    if (inFlight) {
      flushRequestedWhileInFlight = true
      return
    }
    const entries = takePendingEntries()
    if (entries.length === 0) {
      return
    }
    const text = entries.map((entry) => entry.text).join('')
    const inputKind = entries.some((entry) => entry.inputKind === 'external')
      ? 'external'
      : 'query-reply'
    const version = pendingVersion
    let result: unknown
    try {
      result = onFlush(text, inputKind)
    } catch {
      restorePendingEntries(entries, version)
      return
    }
    if (!isPromiseLike(result)) {
      if (result === false) {
        restorePendingEntries(entries, version)
      }
      return
    }
    const currentFlight = Promise.resolve(result)
      .then((accepted) => {
        if (accepted === false) {
          restorePendingEntries(entries, version)
        }
      })
      .catch(() => {
        restorePendingEntries(entries, version)
      })
      .finally(() => {
        if (inFlight !== currentFlight) {
          return
        }
        inFlight = null
        if (flushRequestedWhileInFlight) {
          flushRequestedWhileInFlight = false
          flush()
        }
      })
    inFlight = currentFlight
    if (pending.length > 0) {
      flushRequestedWhileInFlight = true
    }
  }

  const takePending = (): string => {
    const text = pending.map((entry) => entry.text).join('')
    pending = []
    pendingBytes = 0
    clearTimer()
    return text
  }

  const takePendingEntries = (): { text: string; inputKind: RemoteRuntimePtyInputKind }[] => {
    const entries: { text: string; inputKind: RemoteRuntimePtyInputKind }[] = []
    let batchBytes = 0
    while (pending.length > 0) {
      const next = pending[0]!
      const nextBytes = getTerminalInputByteLength(next.text)
      if (entries.length > 0 && batchBytes + nextBytes > maxPendingBytes) {
        break
      }
      entries.push(next)
      pending.shift()
      pendingBytes -= nextBytes
      batchBytes += nextBytes
    }
    clearTimer()
    return entries
  }

  const restorePendingEntries = (
    entries: { text: string; inputKind: RemoteRuntimePtyInputKind }[],
    version: number
  ): void => {
    if (entries.length === 0 || pendingVersion !== version) {
      return
    }
    pending = [...entries, ...pending]
    pendingBytes += entries.reduce(
      (total, entry) => total + getTerminalInputByteLength(entry.text),
      0
    )
    if (!timer) {
      timer = setTimeout(flush, delayMs)
    }
  }

  const queuePending = (
    chunk: string,
    chunkBytes: number,
    inputKind: RemoteRuntimePtyInputKind
  ): void => {
    const previous = pending.at(-1)
    if (
      previous?.inputKind === inputKind &&
      getTerminalInputByteLength(previous.text) + chunkBytes <= maxPendingBytes
    ) {
      previous.text += chunk
    } else {
      pending.push({ text: chunk, inputKind })
    }
    pendingBytes += chunkBytes
    if (!timer) {
      timer = setTimeout(flush, delayMs)
    }
  }

  const pushValidatedInput = (data: string, inputKind: RemoteRuntimePtyInputKind): void => {
    for (const chunk of iterateTerminalInputChunks(data, maxPendingBytes)) {
      const chunkBytes = getTerminalInputByteLength(chunk)
      if (pending.length > 0 && pendingBytes + chunkBytes > maxPendingBytes) {
        flush()
      }
      queuePending(chunk, chunkBytes, inputKind)
      if (chunkBytes >= maxPendingBytes) {
        flush()
      }
    }
  }

  const enqueueValidatedInput = (
    data: string,
    inputKind: RemoteRuntimePtyInputKind,
    tooLarge: false | Promise<boolean>
  ): boolean => {
    if (
      validationQueuedEntries >= maxValidationQueuedEntries ||
      validationQueuedCodeUnits + data.length > maxValidationQueuedCodeUnits
    ) {
      return false
    }
    const queuedVersion = validationVersion
    validationQueuedEntries += 1
    validationQueuedCodeUnits += data.length
    const previousTail = validationTail ?? Promise.resolve()
    const guardedTail = previousTail.then(async () => {
      if (validationVersion !== queuedVersion) {
        return
      }
      if (tooLarge !== false && (await tooLarge.catch(() => true))) {
        return
      }
      if (validationVersion === queuedVersion) {
        pushValidatedInput(data, inputKind)
      }
    })
    const nextTail = guardedTail
      .catch(() => {})
      .finally(() => {
        if (validationVersion === queuedVersion) {
          validationQueuedEntries -= 1
          validationQueuedCodeUnits -= data.length
        }
        if (validationTail === nextTail) {
          validationTail = null
        }
      })
    validationTail = nextTail
    return true
  }

  const drain = async (): Promise<void> => {
    const tail = validationTail
    if (tail) {
      await tail
    }
  }

  return {
    push(data: string, inputKind: RemoteRuntimePtyInputKind = 'external'): boolean {
      if (!data) {
        return true
      }

      const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data, maxBytes)
      if (tooLarge === true) {
        return false
      }

      if (tooLarge === false && validationTail === null) {
        pushValidatedInput(data, inputKind)
        return true
      }

      return enqueueValidatedInput(data, inputKind, tooLarge)
    },
    drain,
    takePending,
    flush,
    clear
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}

function getPositiveByteLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value ?? fallback) : fallback
}

export function createRemoteRuntimeViewportBatcher(
  delayMs: number,
  onFlush: (cols: number, rows: number) => void
): RemoteRuntimeViewportBatcher {
  let pending: { cols: number; rows: number } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pending = null
  }

  const flush = (): void => {
    const viewport = pending
    pending = null
    clear()
    if (viewport) {
      onFlush(viewport.cols, viewport.rows)
    }
  }

  return {
    queue(cols: number, rows: number): void {
      pending = { cols, rows }
      if (!timer) {
        timer = setTimeout(flush, delayMs)
      }
    },
    flush,
    clear
  }
}
