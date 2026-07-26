import {
  getTerminalInputByteLength,
  TERMINAL_INPUT_MAX_BYTES
} from '../../../../shared/terminal-input'

export function createRemoteRuntimeViewportClaimInput(maxBytes = TERMINAL_INPUT_MAX_BYTES) {
  const entries: { text: string; inputKind: 'external' | 'query-reply' }[] = []
  let bytes = 0

  return {
    append(value: string, inputKind: 'external' | 'query-reply' = 'external'): boolean {
      const valueBytes = getTerminalInputByteLength(value)
      if (bytes + valueBytes > maxBytes) {
        return false
      }
      entries.push({ text: value, inputKind })
      bytes += valueBytes
      return true
    },
    clear(): void {
      entries.length = 0
      bytes = 0
    },
    takeEntries(): { text: string; inputKind: 'external' | 'query-reply' }[] {
      const value = entries.splice(0)
      bytes = 0
      return value
    },
    take(): string {
      const value = entries.map((entry) => entry.text).join('')
      entries.length = 0
      bytes = 0
      return value
    }
  }
}
