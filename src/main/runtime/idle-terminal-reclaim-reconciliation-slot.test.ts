import { describe, expect, it } from 'vitest'
import {
  decideIdleTerminalReclaimPostStopOutcome,
  type IdleTerminalReclaimPostStopOutcomeInput,
  type IdleTerminalReclaimPostStopRecord
} from './idle-terminal-reclaim-reconciliation-slot'

type RecordState =
  | 'absent'
  | 'different'
  | 'present-null'
  | 'same-connected'
  | 'same-disconnected'
  | 'same-unstable-object'
  | 'same-unstable-tuple'

function createInput(args: {
  stopResult: boolean | 'threw'
  providerHasPty: boolean | null
  recordState: RecordState
}): IdleTerminalReclaimPostStopOutcomeInput {
  const recordIdentity = {
    ptyId: 'pty-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    incarnationId: 'incarnation-1'
  }
  const capturedRecord: IdleTerminalReclaimPostStopRecord = {
    recordIdentity,
    ptyId: 'pty-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    incarnationId: 'incarnation-1',
    connected: false
  }
  const captured = {
    ptyId: 'pty-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    claimIncarnationId: 'incarnation-1',
    recordIdentity
  }
  const current = (() => {
    switch (args.recordState) {
      case 'absent':
        return null
      case 'different':
        return {
          ...capturedRecord,
          recordIdentity: { ...recordIdentity, incarnationId: 'replacement-incarnation' },
          incarnationId: 'replacement-incarnation',
          connected: true
        }
      case 'present-null':
        return { ...capturedRecord, incarnationId: null }
      case 'same-connected':
        return { ...capturedRecord, connected: true }
      case 'same-disconnected':
        return { ...capturedRecord }
      case 'same-unstable-object':
        return { ...capturedRecord, recordIdentity: { ...recordIdentity } }
      case 'same-unstable-tuple':
        return { ...capturedRecord, leafId: 'replacement-leaf' }
    }
  })()

  return { ...args, captured, current }
}

describe('decideIdleTerminalReclaimPostStopOutcome', () => {
  it.each([
    {
      name: '1 throw with a different non-null replacement',
      stopResult: 'threw' as const,
      providerHasPty: null,
      recordState: 'different' as const,
      expected: 'release-replacement'
    },
    {
      name: '2 throw without a replacement',
      stopResult: 'threw' as const,
      providerHasPty: true,
      recordState: 'absent' as const,
      expected: 'retain-ambiguity'
    },
    {
      name: '3 false stop with a live stable captured record',
      stopResult: false,
      providerHasPty: true,
      recordState: 'same-connected' as const,
      expected: 'release-no-stop'
    },
    {
      name: '4 false stop with an unstable same-incarnation record',
      stopResult: false,
      providerHasPty: true,
      recordState: 'same-unstable-object' as const,
      expected: 'retain-ambiguity'
    },
    {
      name: '5 false stop with a different non-null replacement',
      stopResult: false,
      providerHasPty: false,
      recordState: 'different' as const,
      expected: 'release-replacement'
    },
    {
      name: '6 false stop with an unknown provider state',
      stopResult: false,
      providerHasPty: null,
      recordState: 'same-disconnected' as const,
      expected: 'retain-ambiguity'
    },
    {
      name: '7 true stop with a different non-null replacement',
      stopResult: true,
      providerHasPty: true,
      recordState: 'different' as const,
      expected: 'release-replacement'
    },
    {
      name: '8 true stop without provider absence proof',
      stopResult: true,
      providerHasPty: null,
      recordState: 'same-disconnected' as const,
      expected: 'retain-ambiguity'
    },
    {
      name: '9 true stop with a present null-incarnation record',
      stopResult: true,
      providerHasPty: false,
      recordState: 'present-null' as const,
      expected: 'retain-ambiguity'
    },
    {
      name: '10 true stop with a tuple-rebound same-incarnation record',
      stopResult: true,
      providerHasPty: false,
      recordState: 'same-unstable-tuple' as const,
      expected: 'retain-ambiguity'
    },
    {
      name: '11 true stop with a stable disconnected captured record',
      stopResult: true,
      providerHasPty: false,
      recordState: 'same-disconnected' as const,
      expected: 'continue-exact-retirement'
    },
    {
      name: '12 true stop with an absent record',
      stopResult: true,
      providerHasPty: false,
      recordState: 'absent' as const,
      expected: 'continue-exact-retirement'
    }
  ])('$name', ({ stopResult, providerHasPty, recordState, expected }) => {
    expect(
      decideIdleTerminalReclaimPostStopOutcome(
        createInput({ stopResult, providerHasPty, recordState })
      )
    ).toBe(expected)
  })

  it.each([
    {
      name: 'false stop releases with a newly constructed stable record wrapper',
      stopResult: false as const,
      providerHasPty: true,
      recordState: 'same-connected' as const,
      expected: 'release-no-stop'
    },
    {
      name: 'true stop continues with a newly constructed stable record wrapper',
      stopResult: true as const,
      providerHasPty: false,
      recordState: 'same-disconnected' as const,
      expected: 'continue-exact-retirement'
    }
  ])('$name', ({ stopResult, providerHasPty, recordState, expected }) => {
    const input = createInput({ stopResult, providerHasPty, recordState })

    expect(input.current).not.toBe(input.captured.recordIdentity)
    expect(input.current?.recordIdentity).toBe(input.captured.recordIdentity)
    expect(decideIdleTerminalReclaimPostStopOutcome(input)).toBe(expected)
  })

  it('retains a new wrapper with a field-identical cloned record identity', () => {
    const input = createInput({
      stopResult: true,
      providerHasPty: false,
      recordState: 'same-unstable-object'
    })

    expect(input.current?.recordIdentity).not.toBe(input.captured.recordIdentity)
    expect(decideIdleTerminalReclaimPostStopOutcome(input)).toBe('retain-ambiguity')
  })
})
