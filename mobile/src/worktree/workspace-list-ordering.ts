import type { Worktree } from './workspace-list-types'
import type { MobileSortMode } from './workspace-view-settings'

export const CREATE_GRACE_MS = 5 * 60 * 1000

function getManualSortRank(worktree: Worktree): number | null {
  const rank = worktree.manualOrder ?? worktree.sortOrder
  return typeof rank === 'number' && Number.isFinite(rank) ? rank : null
}

function compareDisplayName(a: Worktree, b: Worktree): number {
  return a.displayName.localeCompare(b.displayName)
}

function getRecentActivity(worktree: Worktree): number {
  const activity = worktree.lastActivityAt ?? worktree.lastOutputAt ?? 0
  return Number.isFinite(activity) ? activity : 0
}

function effectiveRecentActivity(worktree: Worktree, now: number): number {
  const lastActivityAt = getRecentActivity(worktree)
  const { createdAt } = worktree
  if (
    createdAt === undefined ||
    !Number.isFinite(createdAt) ||
    now >= createdAt + CREATE_GRACE_MS
  ) {
    return lastActivityAt
  }
  return Math.max(lastActivityAt, createdAt + CREATE_GRACE_MS)
}

function compareByRecent(a: Worktree, b: Worktree, now: number): number {
  return (
    effectiveRecentActivity(b, now) - effectiveRecentActivity(a, now) || compareDisplayName(a, b)
  )
}

export function sortWorktrees(
  worktrees: Worktree[],
  mode: MobileSortMode,
  now = Date.now()
): Worktree[] {
  if (mode === 'manual') {
    return [...worktrees].sort((a, b) => {
      const aRank = getManualSortRank(a)
      const bRank = getManualSortRank(b)
      if (aRank !== null && bRank !== null && aRank !== bRank) {
        // Why: desktop assigns higher sort/manual ranks to earlier list positions.
        return bRank - aRank
      }
      if (aRank !== null && bRank === null) {
        return -1
      }
      if (aRank === null && bRank !== null) {
        return 1
      }
      return compareDisplayName(a, b)
    })
  }
  return [...worktrees].sort((a, b) => {
    if (mode === 'name') {
      return compareDisplayName(a, b)
    }
    if (mode === 'recent') {
      return compareByRecent(a, b, now)
    }
    if (mode === 'repo') {
      const repoComparison = a.repo.localeCompare(b.repo, undefined, { sensitivity: 'base' })
      return repoComparison || compareDisplayName(a, b)
    }
    if (mode === 'smart') {
      const aRank =
        typeof a.sortOrder === 'number' && Number.isFinite(a.sortOrder) ? a.sortOrder : 0
      const bRank =
        typeof b.sortOrder === 'number' && Number.isFinite(b.sortOrder) ? b.sortOrder : 0
      if (aRank !== bRank) {
        // Why: desktop persists its computed Agent activity order into sortOrder;
        // mobile should render that source-of-truth before local fallback signals.
        return bRank - aRank
      }
      return compareDisplayName(a, b)
    }
    if (a.unread !== b.unread) {
      return a.unread ? -1 : 1
    }
    const aStatus = getWorktreeStatus(a)
    const bStatus = getWorktreeStatus(b)
    const statusOrder = { permission: 0, working: 1, done: 2, active: 3, inactive: 4 }
    if (statusOrder[aStatus] !== statusOrder[bStatus]) {
      return statusOrder[aStatus] - statusOrder[bStatus]
    }
    const recentComparison = compareByRecent(a, b, now)
    if (recentComparison !== 0) {
      return recentComparison
    }
    return compareDisplayName(a, b)
  })
}

export function getWorktreeStatus(
  w: Worktree
): 'working' | 'active' | 'permission' | 'done' | 'inactive' {
  // Why: desktop's sidebar activity is the parity source. Runtime status may
  // still report retained/background PTYs as active after desktop hides them.
  if (w.hasHostSidebarActivity === false) {
    return 'inactive'
  }
  if (w.status && w.status !== 'inactive') {
    return w.status
  }
  if (w.hasHostSidebarActivity === true) {
    return 'active'
  }
  if (w.status) {
    return w.status
  }
  if (w.liveTerminalCount > 0) {
    return 'active'
  }
  return 'inactive'
}
