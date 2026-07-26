import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('OrchestrationDb active dispatch assignees', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  it('lists active assignees for tick-local ownership indexing', () => {
    db = new OrchestrationDb(':memory:')
    const activeTask = db.createTask({ spec: 'active' })
    db.createDispatchContext(activeTask.id, 'term_stale', 'tab_old:leaf_stable')
    const completedTask = db.createTask({ spec: 'completed' })
    const completed = db.createDispatchContext(completedTask.id, 'term_done', 'tab_done:leaf_done')
    db.completeDispatch(completed.id)

    expect(db.getActiveDispatchAssignees()).toEqual([
      { assignee_handle: 'term_stale', assignee_pane_key: 'tab_old:leaf_stable' }
    ])
  })
})
