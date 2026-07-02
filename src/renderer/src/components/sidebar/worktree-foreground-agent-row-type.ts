import type { TerminalForegroundAgentEntry } from '@/store/slices/terminals'
import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../../shared/types'

function countTerminalLayoutLeaves(node: TerminalPaneLayoutNode | null | undefined): number {
  if (!node) {
    return 0
  }
  if (node.type === 'leaf') {
    return 1
  }
  return countTerminalLayoutLeaves(node.first) + countTerminalLayoutLeaves(node.second)
}

export function currentPtyIdForPane(args: {
  paneKey: string
  tab: TerminalTab | null | undefined
  ptyIdsByTabId?: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
}): string | null {
  const tabId = args.tab?.id
  const parsed = parsePaneKey(args.paneKey)
  if (!parsed || !tabId || parsed.tabId !== tabId) {
    return null
  }
  const layout = args.terminalLayoutsByTabId?.[tabId]
  const ptyId = layout?.ptyIdsByLeafId?.[parsed.leafId]
  const livePtyIds = args.ptyIdsByTabId?.[tabId] ?? []
  if (ptyId && livePtyIds.includes(ptyId)) {
    return ptyId
  }
  const leafCount = countTerminalLayoutLeaves(layout?.root)
  // Why: layout metadata can lag a freshly-spawned pane; with a single live PTY
  // and at most one tracked leaf, that PTY is the only plausible owner.
  if (livePtyIds.length === 1 && leafCount <= 1) {
    return livePtyIds[0]!
  }
  return null
}

export function resolveWorktreeForegroundAgentType(args: {
  entry: AgentStatusEntry
  tab?: TerminalTab | null
  foregroundAgentByPaneKey?: Record<string, TerminalForegroundAgentEntry | undefined>
  ptyIdsByTabId?: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
}): AgentType | null {
  const foreground = args.foregroundAgentByPaneKey?.[args.entry.paneKey]
  if (!foreground) {
    return null
  }
  const currentPtyId = currentPtyIdForPane({
    paneKey: args.entry.paneKey,
    tab: args.tab,
    ptyIdsByTabId: args.ptyIdsByTabId,
    terminalLayoutsByTabId: args.terminalLayoutsByTabId
  })
  return currentPtyId === foreground.ptyId ? foreground.agent : null
}
