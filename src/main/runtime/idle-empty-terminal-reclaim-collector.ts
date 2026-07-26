import type {
  IdleEmptyTerminalReclaimCandidate,
  IdleEmptyTerminalReclaimInspection
} from './idle-empty-terminal-reclaim'

export type IdleEmptyTerminalReclaimCandidateSnapshot = Omit<
  IdleEmptyTerminalReclaimCandidate,
  'inspection'
>

export type IdleEmptyTerminalReclaimInspectionReader = (
  ptyId: string
) => Promise<IdleEmptyTerminalReclaimInspection>

const MAX_INSPECTION_CONCURRENCY = 2

export async function collectIdleEmptyTerminalReclaimCandidates(
  snapshots: readonly IdleEmptyTerminalReclaimCandidateSnapshot[],
  inspect: IdleEmptyTerminalReclaimInspectionReader
): Promise<IdleEmptyTerminalReclaimCandidate[]> {
  const candidates: IdleEmptyTerminalReclaimCandidate[] = snapshots.map((snapshot) => ({
    ...snapshot,
    inspection: null
  }))
  let nextIndex = 0

  async function inspectNext(): Promise<void> {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      const candidate = candidates[index]
      if (!candidate) {
        return
      }
      if (!candidate.ptyId) {
        continue
      }
      try {
        candidate.inspection = await inspect(candidate.ptyId)
      } catch {
        candidate.inspection = { status: 'error', foregroundProcess: null, hasChildProcesses: null }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MAX_INSPECTION_CONCURRENCY, candidates.length) }, () =>
      inspectNext()
    )
  )
  return candidates
}
