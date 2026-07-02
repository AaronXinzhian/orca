import type { TerminalForegroundAgentEntry } from '@/store/slices/terminals'
import type { AppState } from '@/store/types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/types'

const EMPTY_RECORD = {}
const EMPTY_FOREGROUND_AGENTS: Record<string, TerminalForegroundAgentEntry> = {}

type ForegroundAgentRowsState = Pick<AppState, 'foregroundAgentByPaneKey' | 'tabsByWorktree'>

type TabWorktreeIndexCache = {
  tabsByWorktree: Record<string, TerminalTab[]>
  tabIdToWorktreeId: Map<string, string>
}

type ForegroundAgentsByWorktreeCache = {
  tabsByWorktree: ForegroundAgentRowsState['tabsByWorktree']
  foregroundAgentByPaneKey: ForegroundAgentRowsState['foregroundAgentByPaneKey']
  entriesByWorktree: Map<string, Record<string, TerminalForegroundAgentEntry>>
}

let tabWorktreeIndexCache: TabWorktreeIndexCache | null = null
let foregroundAgentsByWorktreeCache: ForegroundAgentsByWorktreeCache | null = null

// Why: the sidebar selects one worktree at a time; preserving per-worktree
// record identity avoids render churn when unrelated foreground entries change.
function getTabIdToWorktreeId(tabsByWorktree: Record<string, TerminalTab[]>): Map<string, string> {
  if (tabWorktreeIndexCache?.tabsByWorktree === tabsByWorktree) {
    return tabWorktreeIndexCache.tabIdToWorktreeId
  }
  const tabIdToWorktreeId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs) {
      tabIdToWorktreeId.set(tab.id, worktreeId)
    }
  }
  tabWorktreeIndexCache = { tabsByWorktree, tabIdToWorktreeId }
  return tabIdToWorktreeId
}

function reuseForegroundRecordIfEqual(
  previous: Record<string, TerminalForegroundAgentEntry> | undefined,
  next: Record<string, TerminalForegroundAgentEntry>
): Record<string, TerminalForegroundAgentEntry> {
  if (!previous) {
    return next
  }
  const entryKeys = Object.keys(next)
  const previousKeys = Object.keys(previous)
  if (
    entryKeys.length === previousKeys.length &&
    entryKeys.every((key) => previous[key] === next[key])
  ) {
    return previous
  }
  return next
}

function getForegroundAgentsByWorktree(
  state: ForegroundAgentRowsState
): Map<string, Record<string, TerminalForegroundAgentEntry>> {
  const foregroundAgentByPaneKey = state.foregroundAgentByPaneKey ?? EMPTY_RECORD
  const tabsByWorktree = state.tabsByWorktree ?? EMPTY_RECORD
  if (
    foregroundAgentsByWorktreeCache?.tabsByWorktree === tabsByWorktree &&
    foregroundAgentsByWorktreeCache.foregroundAgentByPaneKey === foregroundAgentByPaneKey
  ) {
    return foregroundAgentsByWorktreeCache.entriesByWorktree
  }

  const tabIdToWorktreeId = getTabIdToWorktreeId(tabsByWorktree)
  const previous = foregroundAgentsByWorktreeCache?.entriesByWorktree
  const entriesByWorktree = new Map<string, Record<string, TerminalForegroundAgentEntry>>()
  for (const [paneKey, entry] of Object.entries(foregroundAgentByPaneKey)) {
    const parsed = parsePaneKey(paneKey)
    const worktreeId = parsed ? tabIdToWorktreeId.get(parsed.tabId) : undefined
    if (!worktreeId) {
      continue
    }
    const bucket = entriesByWorktree.get(worktreeId)
    if (bucket) {
      bucket[paneKey] = entry
    } else {
      entriesByWorktree.set(worktreeId, { [paneKey]: entry })
    }
  }
  for (const [worktreeId, entries] of entriesByWorktree) {
    entriesByWorktree.set(
      worktreeId,
      reuseForegroundRecordIfEqual(previous?.get(worktreeId), entries)
    )
  }
  foregroundAgentsByWorktreeCache = {
    tabsByWorktree,
    foregroundAgentByPaneKey,
    entriesByWorktree
  }
  return entriesByWorktree
}

export function selectForegroundAgentsForWorktree(
  state: ForegroundAgentRowsState,
  worktreeId: string
): Record<string, TerminalForegroundAgentEntry> {
  return getForegroundAgentsByWorktree(state).get(worktreeId) ?? EMPTY_FOREGROUND_AGENTS
}
