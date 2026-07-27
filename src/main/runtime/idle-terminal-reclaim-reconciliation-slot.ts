export type IdleTerminalReclaimAmbiguityLatch = {
  claimIncarnationId: string
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
}

export type IdleTerminalReclaimReservation = {
  kind: 'reservation'
}

export type IdleTerminalReclaimReconciliationSlot =
  | IdleTerminalReclaimReservation
  | { kind: 'ambiguity-latch'; latch: IdleTerminalReclaimAmbiguityLatch }
