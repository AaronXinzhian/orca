import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type { TerminalForegroundAgentEntry } from '@/store/slices/terminals'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import { resolveCompatibleAgentTypeForOwner } from '../../../../shared/agent-title-owner'
import { resolveWorktreeForegroundAgentType } from './worktree-foreground-agent-row-type'
import { resolveAgentTypeFromTerminalTitle } from './worktree-title-derived-agent-rows'

/**
 * Resolves the sidebar row agent type, normalizing compatible agent kinds.
 */
export function resolveRowAgentType(args: {
  entry: AgentStatusEntry
  tab?: TerminalTab | null
  foregroundAgentByPaneKey?: Record<string, TerminalForegroundAgentEntry | undefined>
  ptyIdsByTabId?: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
}): AgentType {
  const { entry, tab } = args
  const foregroundAgentType = resolveWorktreeForegroundAgentType(args)
  if (foregroundAgentType) {
    // Why: this is the same recognized foreground process that drives the tab
    // icon, so it beats stale hook/title/launch identity for the same live PTY.
    return foregroundAgentType
  }
  const entryAgentType = resolveCompatibleAgentTypeForOwner(entry.agentType, tab?.launchAgent)
  const titleAgentType = resolveAgentTypeFromTerminalTitle(
    entry.terminalTitle ?? tab?.title,
    tab?.launchAgent
  )
  if (entryAgentType && entryAgentType !== 'unknown') {
    return entryAgentType
  }
  return titleAgentType ?? tab?.launchAgent ?? entryAgentType ?? 'unknown'
}
