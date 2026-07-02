import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { TerminalForegroundAgentEntry } from '@/store/slices/terminals'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import { currentPtyIdForPane } from './worktree-foreground-agent-row-type'

export function buildForegroundDerivedAgentRows(args: {
  foregroundAgentByPaneKey?: Record<string, TerminalForegroundAgentEntry | undefined>
  ptyIdsByTabId?: Record<string, string[]>
  seenPaneKeys: Set<string>
  tabs: TerminalTab[]
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
}): DashboardAgentRow[] {
  const rows: DashboardAgentRow[] = []
  for (const [paneKey, foreground] of Object.entries(args.foregroundAgentByPaneKey ?? {})) {
    if (!foreground || args.seenPaneKeys.has(paneKey)) {
      continue
    }
    const parsed = parsePaneKey(paneKey)
    const tab = parsed ? args.tabs.find((entry) => entry.id === parsed.tabId) : undefined
    if (!tab) {
      continue
    }
    const currentPtyId = currentPtyIdForPane({
      paneKey,
      tab,
      ptyIdsByTabId: args.ptyIdsByTabId,
      terminalLayoutsByTabId: args.terminalLayoutsByTabId
    })
    if (currentPtyId !== foreground.ptyId) {
      continue
    }
    const rowEntry: AgentStatusEntry = {
      paneKey,
      state: 'working',
      prompt: '',
      updatedAt: foreground.updatedAt,
      stateStartedAt: foreground.updatedAt,
      stateHistory: [],
      agentType: foreground.agent,
      terminalTitle: tab.title
    }
    rows.push({
      paneKey,
      entry: rowEntry,
      tab,
      agentType: foreground.agent,
      rowSource: 'live',
      state: 'working',
      startedAt: foreground.updatedAt
    })
    args.seenPaneKeys.add(paneKey)
  }
  return rows
}
