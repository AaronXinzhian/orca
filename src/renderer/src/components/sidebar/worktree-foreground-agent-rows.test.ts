import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { buildWorktreeAgentRows } from './worktree-agent-rows'

const LEAF_ID_1 = '22222222-2222-4222-8222-222222222222'
const LEAF_ID_1_SECOND = '77777777-7777-4777-8777-777777777777'
const PANE_KEY_1 = makePaneKey('tab-1', LEAF_ID_1)
const PANE_KEY_2 = makePaneKey('tab-2', '33333333-3333-4333-8333-333333333333')
const PANE_KEY_4 = makePaneKey('tab-4', '66666666-6666-4666-8666-666666666666')

function makeTab(id: string, overrides?: Partial<TerminalTab>): TerminalTab {
  return {
    id,
    worktreeId: 'wt-1',
    ptyId: null,
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function makeEntry(
  paneKey: string,
  startedAt: number,
  overrides?: Partial<AgentStatusEntry>
): AgentStatusEntry {
  return {
    paneKey,
    state: 'done',
    stateStartedAt: startedAt,
    updatedAt: startedAt,
    stateHistory: [],
    prompt: 'finished prompt',
    agentType: 'claude',
    terminalTitle: undefined,
    interrupted: false,
    ...overrides
  }
}

function makeRetained(
  paneKey: string,
  worktreeId: string,
  startedAt: number,
  overrides?: Partial<RetainedAgentEntry>
): RetainedAgentEntry {
  const tab = makeTab(paneKey.slice(0, paneKey.indexOf(':')))
  return {
    entry: makeEntry(paneKey, startedAt),
    worktreeId,
    tab,
    agentType: 'claude',
    startedAt,
    ...overrides
  }
}

function makeSinglePaneLayout(leafId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null
  }
}

function makeSplitPaneLayout(firstLeafId: string, secondLeafId: string): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: firstLeafId },
      second: { type: 'leaf', leafId: secondLeafId }
    },
    activeLeafId: firstLeafId,
    expandedLeafId: null
  }
}

describe('buildWorktreeAgentRows foreground agent identity', () => {
  it('prefers matching foreground agent identity over stale hook and launch identity', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { launchAgent: 'claude', title: '\u280b Claude' })],
      entries: [
        makeEntry(PANE_KEY_1, 1000, {
          state: 'working',
          agentType: 'claude',
          terminalTitle: '\u280b Claude'
        })
      ],
      retained: [],
      foregroundAgentByPaneKey: {
        [PANE_KEY_1]: { agent: 'codex', ptyId: 'pty-1', updatedAt: 1 }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeSinglePaneLayout(LEAF_ID_1),
          ptyIdsByLeafId: { [LEAF_ID_1]: 'pty-1' }
        }
      },
      now: 2000
    })

    expect(rows[0].agentType).toBe('codex')
  })

  it('keeps foreground identity authoritative without wall-clock expiry', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { launchAgent: 'claude' })],
      entries: [
        makeEntry(PANE_KEY_1, 1000, {
          state: 'working',
          agentType: 'claude'
        })
      ],
      retained: [],
      foregroundAgentByPaneKey: {
        [PANE_KEY_1]: { agent: 'codex', ptyId: 'pty-1', updatedAt: 1 }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeSinglePaneLayout(LEAF_ID_1),
          ptyIdsByLeafId: { [LEAF_ID_1]: 'pty-1' }
        }
      },
      now: 1_000_000
    })

    expect(rows[0].agentType).toBe('codex')
  })

  it('does not use foreground identity for the wrong PTY or wrong pane', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1'), makeTab('tab-2')],
      entries: [
        makeEntry(PANE_KEY_1, 1000, {
          state: 'working',
          agentType: 'claude'
        }),
        makeEntry(PANE_KEY_2, 1000, {
          state: 'working',
          agentType: 'claude'
        })
      ],
      retained: [],
      foregroundAgentByPaneKey: {
        [PANE_KEY_1]: { agent: 'codex', ptyId: 'pty-other', updatedAt: 1000 },
        [PANE_KEY_4]: { agent: 'gemini', ptyId: 'pty-2', updatedAt: 1000 }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'], 'tab-2': ['pty-2'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeSinglePaneLayout(LEAF_ID_1),
          ptyIdsByLeafId: { [LEAF_ID_1]: 'pty-1' }
        }
      },
      now: 2000
    })

    expect(rows.map((row) => [row.paneKey, row.agentType])).toEqual([
      [PANE_KEY_1, 'claude'],
      [PANE_KEY_2, 'claude']
    ])
  })

  it('uses foreground identity for live done rows but not retained history', () => {
    const retained = makeRetained(PANE_KEY_2, 'wt-1', 900, {
      entry: makeEntry(PANE_KEY_2, 900, {
        state: 'done',
        agentType: 'claude'
      }),
      tab: makeTab('tab-2')
    })
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [
        makeEntry(PANE_KEY_1, 1000, {
          state: 'done',
          agentType: 'claude'
        })
      ],
      retained: [retained],
      foregroundAgentByPaneKey: {
        [PANE_KEY_1]: { agent: 'codex', ptyId: 'pty-1', updatedAt: 1000 },
        [PANE_KEY_2]: { agent: 'codex', ptyId: 'pty-2', updatedAt: 1000 }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'], 'tab-2': ['pty-2'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeSinglePaneLayout(LEAF_ID_1),
          ptyIdsByLeafId: { [LEAF_ID_1]: 'pty-1' }
        }
      },
      now: 2000
    })

    expect(rows.map((row) => [row.rowSource, row.agentType])).toEqual([
      ['retained', 'claude'],
      ['live', 'codex']
    ])
  })

  it('does not use single-PTY foreground fallback for ambiguous multi-PTY tabs', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [
        makeEntry(PANE_KEY_1, 1000, {
          state: 'working',
          agentType: 'claude'
        })
      ],
      retained: [],
      foregroundAgentByPaneKey: {
        [PANE_KEY_1]: { agent: 'codex', ptyId: 'pty-agent', updatedAt: 1000 }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-agent', 'pty-shell'] },
      terminalLayoutsByTabId: {
        'tab-1': makeSplitPaneLayout(LEAF_ID_1, LEAF_ID_1_SECOND)
      },
      now: 2000
    })

    expect(rows[0].agentType).toBe('claude')
  })

  it('prefers foreground identity for title-derived rows without hook status', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { title: '\u280b Claude Code' })],
      entries: [],
      retained: [],
      foregroundAgentByPaneKey: {
        [PANE_KEY_1]: { agent: 'codex', ptyId: 'pty-1', updatedAt: 1 }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeSinglePaneLayout(LEAF_ID_1),
          ptyIdsByLeafId: { [LEAF_ID_1]: 'pty-1' }
        }
      },
      now: 2000
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].agentType).toBe('codex')
    expect(rows[0].entry.agentType).toBe('codex')
  })

  it('creates a live row from foreground identity without hook or title evidence', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { title: 'zsh' })],
      entries: [],
      retained: [],
      foregroundAgentByPaneKey: {
        [PANE_KEY_1]: { agent: 'codex', ptyId: 'pty-1', updatedAt: 1000 }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeSinglePaneLayout(LEAF_ID_1),
          ptyIdsByLeafId: { [LEAF_ID_1]: 'pty-1' }
        }
      },
      now: 2000
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      paneKey: PANE_KEY_1,
      agentType: 'codex',
      rowSource: 'live',
      state: 'working'
    })
    expect(rows[0].entry.agentType).toBe('codex')
  })

  it('does not create a foreground row from a stale layout PTY that is no longer live', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { title: 'zsh' })],
      entries: [],
      retained: [],
      foregroundAgentByPaneKey: {
        [PANE_KEY_1]: { agent: 'codex', ptyId: 'ssh:connection-1@@pty-1', updatedAt: 1000 }
      },
      ptyIdsByTabId: { 'tab-1': [] },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeSinglePaneLayout(LEAF_ID_1),
          ptyIdsByLeafId: { [LEAF_ID_1]: 'ssh:connection-1@@pty-1' }
        }
      },
      now: 2000
    })

    expect(rows).toEqual([])
  })
})
