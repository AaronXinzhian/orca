import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { getTitleForegroundKey } from '../../../../shared/terminal-foreground-title-key'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab,
  TuiAgent
} from '../../../../shared/types'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import {
  resolveLeafIdForTitleFallback,
  titleCanBuildTitleDerivedAgentRow
} from './worktree-title-derived-agent-rows'

export type ForegroundSyncTarget = {
  launchAgent?: TuiAgent
  lifecycleKey: string
  paneKey: string
  ptyId: string
  titleForegroundKey: string
}

export function targetKey(target: ForegroundSyncTarget): string {
  return `${target.paneKey}\u0000${target.ptyId}\u0000${target.titleForegroundKey}\u0000${target.lifecycleKey}\u0000${target.launchAgent ?? ''}`
}

function isLocalForegroundProbePtyId(ptyId: string): boolean {
  return parseRemoteRuntimePtyId(ptyId) === null
}

function collectLeafIds(node: TerminalPaneLayoutNode | null | undefined): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectLeafIds(node.first), ...collectLeafIds(node.second)]
}

function activeLeafIdForLayout(layout: TerminalLayoutSnapshot | undefined): string | null {
  return layout?.activeLeafId ?? (layout?.root?.type === 'leaf' ? layout.root.leafId : null)
}

function collectPanesWithLocalPtys(args: {
  layout: TerminalLayoutSnapshot | undefined
  ptyIds: string[]
  tabId: string
}): Map<string, { paneKey: string; ptyId: string }> {
  const panes = new Map<string, { paneKey: string; ptyId: string }>()
  const livePtyIds = new Set(args.ptyIds)
  for (const [leafId, ptyId] of Object.entries(args.layout?.ptyIdsByLeafId ?? {})) {
    if (
      !isTerminalLeafId(leafId) ||
      !livePtyIds.has(ptyId) ||
      !isLocalForegroundProbePtyId(ptyId)
    ) {
      continue
    }
    panes.set(leafId, { paneKey: makePaneKey(args.tabId, leafId), ptyId })
  }
  if (panes.size > 0) {
    return panes
  }
  const activeLeafId = activeLeafIdForLayout(args.layout)
  if (
    args.ptyIds.length === 1 &&
    activeLeafId &&
    isTerminalLeafId(activeLeafId) &&
    isLocalForegroundProbePtyId(args.ptyIds[0]!)
  ) {
    panes.set(activeLeafId, {
      paneKey: makePaneKey(args.tabId, activeLeafId),
      ptyId: args.ptyIds[0]!
    })
  }
  return panes
}

function collectRowRelevantPaneTargets(args: {
  liveEntries: readonly AgentStatusEntry[]
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  tab: TerminalTab
  layout: TerminalLayoutSnapshot | undefined
}): Map<string, { lifecycleKey: string; titleForegroundKey: string }> {
  const targetByPaneKey = new Map<string, { lifecycleKey: string; titleForegroundKey: string }>()
  for (const entry of args.liveEntries) {
    const parsed = parsePaneKey(entry.paneKey)
    if (parsed?.tabId === args.tab.id) {
      targetByPaneKey.set(entry.paneKey, {
        // Why: hook lifecycle transitions can prove foreground may have changed
        // even when the terminal title and PTY stay stable.
        lifecycleKey: `entry:${entry.state}:${entry.stateStartedAt}:${entry.agentType}:${entry.terminalTitle ?? ''}`,
        titleForegroundKey: getTitleForegroundKey(
          entry.terminalTitle ?? args.tab.title,
          args.tab.launchAgent
        )
      })
    }
  }
  const runtimePaneTitles = args.runtimePaneTitlesByTabId[args.tab.id]
  const paneTitleEntries =
    runtimePaneTitles && Object.keys(runtimePaneTitles).length > 0
      ? Object.entries(runtimePaneTitles).sort(([a], [b]) => Number(a) - Number(b))
      : []
  if (paneTitleEntries.length > 0) {
    for (const [paneId, title] of paneTitleEntries) {
      const leafId = resolveLeafIdForTitleFallback({
        layout: args.layout,
        paneTitleEntries,
        paneId: Number(paneId),
        title
      })
      if (leafId && isTerminalLeafId(leafId)) {
        const paneKey = makePaneKey(args.tab.id, leafId)
        // Why: a live row whose title changes back to shell/unknown needs one
        // re-read so stale foreground identity can be cleared.
        if (
          titleCanBuildTitleDerivedAgentRow(title, args.tab.launchAgent) ||
          targetByPaneKey.has(paneKey)
        ) {
          targetByPaneKey.set(paneKey, {
            lifecycleKey: targetByPaneKey.get(paneKey)?.lifecycleKey ?? 'title',
            titleForegroundKey: getTitleForegroundKey(title, args.tab.launchAgent)
          })
        }
      }
    }
    return targetByPaneKey
  }
  if (!titleCanBuildTitleDerivedAgentRow(args.tab.title, args.tab.launchAgent)) {
    return targetByPaneKey
  }
  const leafId = args.layout?.activeLeafId ?? collectLeafIds(args.layout?.root ?? null)[0]
  if (leafId && isTerminalLeafId(leafId)) {
    const paneKey = makePaneKey(args.tab.id, leafId)
    targetByPaneKey.set(paneKey, {
      lifecycleKey: targetByPaneKey.get(paneKey)?.lifecycleKey ?? 'title',
      titleForegroundKey: getTitleForegroundKey(args.tab.title, args.tab.launchAgent)
    })
  }
  return targetByPaneKey
}

export function collectForegroundSyncTargets(args: {
  liveEntries: readonly AgentStatusEntry[]
  ptyIdsByTabId: Record<string, string[]>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  skipActivePaneTargets: boolean
  tabs: TerminalTab[] | undefined
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
}): ForegroundSyncTarget[] {
  return (args.tabs ?? []).flatMap((tab): ForegroundSyncTarget[] => {
    const layout = args.terminalLayoutsByTabId[tab.id]
    const activeLeafId = args.skipActivePaneTargets ? activeLeafIdForLayout(layout) : null
    const panesByLeafId = collectPanesWithLocalPtys({
      layout,
      ptyIds: args.ptyIdsByTabId[tab.id] ?? [],
      tabId: tab.id
    })
    if (panesByLeafId.size === 0) {
      return []
    }
    const relevantTitleKeysByPaneKey = collectRowRelevantPaneTargets({
      liveEntries: args.liveEntries,
      runtimePaneTitlesByTabId: args.runtimePaneTitlesByTabId,
      tab,
      layout
    })
    return [...panesByLeafId.entries()].flatMap(([leafId, pane]): ForegroundSyncTarget[] => {
      if (leafId === activeLeafId) {
        return []
      }
      const target = relevantTitleKeysByPaneKey.get(pane.paneKey) ?? {
        lifecycleKey: 'visible-pane',
        titleForegroundKey: 'visible-pane'
      }
      return [
        {
          ...pane,
          launchAgent: tab.launchAgent,
          lifecycleKey: target.lifecycleKey,
          titleForegroundKey: target.titleForegroundKey
        }
      ]
    })
  })
}
