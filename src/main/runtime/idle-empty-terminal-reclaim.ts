import {
  isTerminalIdleEmptyReclaimEligible,
  normalizeTerminalCreationOrigin,
  normalizeTerminalIdleEmptyReclaimMs
} from '../../shared/terminal-idle-reclaim'

export type IdleEmptyTerminalReclaimCloseMode =
  | 'renderer-owned-persisted'
  | 'runtime-owned-persisted'
  | 'hot-only'

export type IdleEmptyTerminalReclaimRefusalReason =
  | 'feature-disabled'
  | 'origin-not-eligible'
  | 'topology-or-binding-invalid'
  | 'protected-terminal-state'
  | 'terminal-used-or-has-launch-work'
  | 'agent-or-orchestration-owned'
  | 'not-idle-or-activity-stale'
  | 'provider-unavailable-or-incarnation-stale'
  | 'foreground-process-not-empty-shell'
  | 'renderer-visible'
  | 'mobile-or-remote-viewer-attached'
  | 'active-coordinator-or-dispatch'
  | 'terminal-transaction-in-flight'
  | 'final-confirmation-or-claim-missing'

export type IdleEmptyTerminalReclaimInspection = {
  status: 'success' | 'error'
  foregroundProcess: 'shell' | 'wrapper' | 'other' | null
  hasChildProcesses: boolean | null
} | null

export type IdleEmptyTerminalReclaimCandidate = {
  tabId: string | null
  leafId: string | null
  ptyId: string | null
  worktreeId: string | null
  incarnationId: string | null
  expectedIncarnationId: string | null
  activityGeneration: number | null
  expectedActivityGeneration: number | null
  isSinglePane: boolean | null
  hasExactTabLeafPtyWorktreeBinding: boolean | null
  hasSharedPty: boolean | null
  isPersisted: boolean | null
  rendererOwnsPersistedTab: boolean | null
  origin?: unknown
  used?: unknown
  isPinned: boolean | null
  isSleepingOrHibernating: boolean | null
  hasPendingRestoreOrReconnect: boolean | null
  hasStartupCommand: boolean | null
  hasLaunchConfig: boolean | null
  hasResumeProviderSession: boolean | null
  hasLaunchAgent: boolean | null
  hasForegroundAgent: boolean | null
  agentStatus: 'none' | 'working' | 'blocked' | 'waiting' | 'done' | null
  hasProviderSession: boolean | null
  hasOrchestrationOwnership: boolean | null
  lastActivityAt: number | null
  providerConnected: boolean | null
  providerWritable: boolean | null
  inspection: IdleEmptyTerminalReclaimInspection
  rendererVisibility: 'hidden' | 'visible' | null
  hasMobileDriver: boolean | null
  hasMobileSubscriber: boolean | null
  hasRemoteDesktopViewer: boolean | null
  isActiveCoordinatorHandle: boolean | null
  hasPendingOrDispatchedContext: boolean | null
  hasInFlightTransaction: boolean | null
  hasSecondConfirmation: boolean | null
  hasExactIdentityClaim: boolean | null
}

export type IdleEmptyTerminalReclaimConfig = {
  enabled?: unknown
  idleThresholdMs?: unknown
}

export type IdleEmptyTerminalReclaimEvaluation =
  | {
      eligible: true
      closeMode: IdleEmptyTerminalReclaimCloseMode
    }
  | {
      eligible: false
      closeMode: IdleEmptyTerminalReclaimCloseMode | null
      reason: IdleEmptyTerminalReclaimRefusalReason
    }

function isNonEmptyString(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0
}

function classifyCloseMode(
  candidate: IdleEmptyTerminalReclaimCandidate
): IdleEmptyTerminalReclaimCloseMode | null {
  if (candidate.isPersisted === false) {
    return 'hot-only'
  }
  if (candidate.isPersisted !== true) {
    return null
  }
  if (candidate.rendererOwnsPersistedTab === true) {
    return 'renderer-owned-persisted'
  }
  if (candidate.rendererOwnsPersistedTab === false) {
    return 'runtime-owned-persisted'
  }
  return null
}

function refused(
  reason: IdleEmptyTerminalReclaimRefusalReason,
  closeMode: IdleEmptyTerminalReclaimCloseMode | null
): IdleEmptyTerminalReclaimEvaluation {
  return { eligible: false, closeMode, reason }
}

export function evaluateIdleReclaimCandidate(
  candidate: IdleEmptyTerminalReclaimCandidate,
  config: IdleEmptyTerminalReclaimConfig,
  now: number
): IdleEmptyTerminalReclaimEvaluation {
  const closeMode = classifyCloseMode(candidate)
  const idleThresholdMs = normalizeTerminalIdleEmptyReclaimMs(config.idleThresholdMs)

  if (config.enabled !== true) {
    return refused('feature-disabled', closeMode)
  }

  const origin = normalizeTerminalCreationOrigin(candidate.origin)
  if (origin !== 'cli' && origin !== 'orchestration') {
    return refused('origin-not-eligible', closeMode)
  }

  if (
    !isNonEmptyString(candidate.tabId) ||
    !isNonEmptyString(candidate.leafId) ||
    !isNonEmptyString(candidate.ptyId) ||
    !isNonEmptyString(candidate.worktreeId) ||
    candidate.isSinglePane !== true ||
    candidate.hasExactTabLeafPtyWorktreeBinding !== true ||
    candidate.hasSharedPty !== false ||
    closeMode === null
  ) {
    return refused('topology-or-binding-invalid', closeMode)
  }

  if (
    candidate.isPinned !== false ||
    candidate.isSleepingOrHibernating !== false ||
    candidate.hasPendingRestoreOrReconnect !== false
  ) {
    return refused('protected-terminal-state', closeMode)
  }

  if (
    !isTerminalIdleEmptyReclaimEligible({
      creationOrigin: origin,
      hasEverReceivedExternalInput: candidate.used
    }) ||
    candidate.used !== false ||
    candidate.hasStartupCommand !== false ||
    candidate.hasLaunchConfig !== false ||
    candidate.hasResumeProviderSession !== false ||
    candidate.hasLaunchAgent !== false
  ) {
    return refused('terminal-used-or-has-launch-work', closeMode)
  }

  if (
    candidate.hasForegroundAgent !== false ||
    candidate.agentStatus !== 'none' ||
    candidate.hasProviderSession !== false ||
    candidate.hasOrchestrationOwnership !== false
  ) {
    return refused('agent-or-orchestration-owned', closeMode)
  }

  if (
    !Number.isFinite(now) ||
    typeof candidate.lastActivityAt !== 'number' ||
    !Number.isFinite(candidate.lastActivityAt) ||
    now - candidate.lastActivityAt < idleThresholdMs ||
    typeof candidate.activityGeneration !== 'number' ||
    !Number.isInteger(candidate.activityGeneration) ||
    typeof candidate.expectedActivityGeneration !== 'number' ||
    candidate.activityGeneration !== candidate.expectedActivityGeneration
  ) {
    return refused('not-idle-or-activity-stale', closeMode)
  }

  if (
    candidate.providerConnected !== true ||
    candidate.providerWritable !== true ||
    !isNonEmptyString(candidate.incarnationId) ||
    candidate.incarnationId !== candidate.expectedIncarnationId
  ) {
    return refused('provider-unavailable-or-incarnation-stale', closeMode)
  }

  const inspection = candidate.inspection
  if (
    inspection === null ||
    inspection.status !== 'success' ||
    inspection.foregroundProcess !== 'shell' ||
    inspection.hasChildProcesses !== false
  ) {
    return refused('foreground-process-not-empty-shell', closeMode)
  }

  if (candidate.rendererVisibility !== 'hidden') {
    return refused('renderer-visible', closeMode)
  }

  if (
    candidate.hasMobileDriver !== false ||
    candidate.hasMobileSubscriber !== false ||
    candidate.hasRemoteDesktopViewer !== false
  ) {
    return refused('mobile-or-remote-viewer-attached', closeMode)
  }

  if (
    candidate.isActiveCoordinatorHandle !== false ||
    candidate.hasPendingOrDispatchedContext !== false
  ) {
    return refused('active-coordinator-or-dispatch', closeMode)
  }

  if (candidate.hasInFlightTransaction !== false) {
    return refused('terminal-transaction-in-flight', closeMode)
  }

  if (candidate.hasSecondConfirmation !== true || candidate.hasExactIdentityClaim !== true) {
    return refused('final-confirmation-or-claim-missing', closeMode)
  }

  return { eligible: true, closeMode }
}
