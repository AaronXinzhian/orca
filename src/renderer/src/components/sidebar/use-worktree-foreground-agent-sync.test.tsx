// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'

const initialAppState = useAppStore.getInitialState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)
const SECOND_PANE_KEY = makePaneKey('tab-1', SECOND_LEAF_ID)
const roots: Root[] = []

function makeTab(overrides?: Partial<TerminalTab>): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'Codex',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    launchAgent: 'codex',
    ...overrides
  }
}

function makeAgentStatusEntry(overrides?: Partial<AgentStatusEntry>): AgentStatusEntry {
  return {
    paneKey: PANE_KEY,
    state: 'working',
    stateStartedAt: 1,
    updatedAt: 1,
    stateHistory: [],
    prompt: 'Fix it',
    agentType: 'claude',
    terminalTitle: 'Claude',
    interrupted: false,
    ...overrides
  }
}

function singlePaneLayout(ptyId: string, leafId = LEAF_ID): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

function splitPaneLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: LEAF_ID },
      second: { type: 'leaf', leafId: SECOND_LEAF_ID }
    },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: {
      [LEAF_ID]: 'pty-shell',
      [SECOND_LEAF_ID]: 'pty-agent'
    }
  }
}

function RowsProbe({
  active = true,
  syncForeground = active
}: {
  active?: boolean
  syncForeground?: boolean
}): null {
  useWorktreeAgentRows('wt-1', active, syncForeground)
  return null
}

async function renderProbe(props?: { active?: boolean; syncForeground?: boolean }): Promise<Root> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<RowsProbe {...props} />)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return root
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useWorktreeForegroundAgentSync', () => {
  const originalApi = window.api
  const getForegroundProcess = vi.fn()

  beforeEach(() => {
    getForegroundProcess.mockReset()
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      activeWorktreeId: 'wt-active',
      tabsByWorktree: { 'wt-1': [makeTab()] },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: { 'tab-1': singlePaneLayout('pty-1') },
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {},
      foregroundAgentByPaneKey: {}
    })
    window.api = {
      ...originalApi,
      pty: {
        ...originalApi?.pty,
        getForegroundProcess
      }
    } as typeof window.api
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
    window.api = originalApi
  })

  it('publishes foreground identity for a visible inactive worktree card', async () => {
    getForegroundProcess.mockResolvedValueOnce('codex')

    await renderProbe()

    expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(useAppStore.getState().foregroundAgentByPaneKey[PANE_KEY]).toMatchObject({
      agent: 'codex',
      ptyId: 'pty-1'
    })
  })

  it('clears stale foreground identity when a changed target read fails', async () => {
    useAppStore.setState({
      agentStatusByPaneKey: {
        [PANE_KEY]: makeAgentStatusEntry({
          state: 'working',
          stateStartedAt: 1,
          terminalTitle: 'Claude'
        })
      },
      foregroundAgentByPaneKey: {
        [PANE_KEY]: { agent: 'claude', ptyId: 'pty-1', updatedAt: 1 }
      }
    })
    getForegroundProcess.mockRejectedValueOnce(new Error('foreground unavailable'))

    await renderProbe()

    expect(useAppStore.getState().foregroundAgentByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('clears published foreground identity when the visible card unmounts', async () => {
    getForegroundProcess.mockResolvedValueOnce('codex')

    const root = await renderProbe()
    expect(useAppStore.getState().foregroundAgentByPaneKey[PANE_KEY]).toMatchObject({
      agent: 'codex'
    })

    await act(async () => {
      root.unmount()
    })
    roots.splice(roots.indexOf(root), 1)

    expect(useAppStore.getState().foregroundAgentByPaneKey).toEqual({})
  })

  it('keeps foreground identity while a duplicate visible card still owns the pane', async () => {
    getForegroundProcess.mockResolvedValue('codex')

    const firstRoot = await renderProbe()
    const secondRoot = await renderProbe()

    expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(useAppStore.getState().foregroundAgentByPaneKey[PANE_KEY]).toMatchObject({
      agent: 'codex'
    })

    await act(async () => {
      firstRoot.unmount()
    })
    roots.splice(roots.indexOf(firstRoot), 1)

    expect(useAppStore.getState().foregroundAgentByPaneKey[PANE_KEY]).toMatchObject({
      agent: 'codex'
    })

    await act(async () => {
      secondRoot.unmount()
    })
    roots.splice(roots.indexOf(secondRoot), 1)

    expect(useAppStore.getState().foregroundAgentByPaneKey).toEqual({})
  })

  it('keeps a duplicate owner helper retry alive after the first reader unmounts', async () => {
    vi.useFakeTimers()
    getForegroundProcess.mockResolvedValueOnce('uv').mockResolvedValueOnce('codex')

    try {
      const firstRoot = await renderProbe()
      const secondRoot = await renderProbe()

      expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')

      await act(async () => {
        firstRoot.unmount()
      })
      roots.splice(roots.indexOf(firstRoot), 1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })
      await flushEffects()

      expect(getForegroundProcess).toHaveBeenCalledTimes(2)
      expect(useAppStore.getState().foregroundAgentByPaneKey[PANE_KEY]).toMatchObject({
        agent: 'codex',
        ptyId: 'pty-1'
      })

      await act(async () => {
        secondRoot.unmount()
      })
      roots.splice(roots.indexOf(secondRoot), 1)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('cancels duplicate owner helper retries after all readers unmount', async () => {
    vi.useFakeTimers()
    getForegroundProcess.mockResolvedValueOnce('uv').mockResolvedValueOnce('codex')

    try {
      const firstRoot = await renderProbe()
      const secondRoot = await renderProbe()

      expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')

      await act(async () => {
        firstRoot.unmount()
        secondRoot.unmount()
      })
      roots.splice(roots.indexOf(firstRoot), 1)
      roots.splice(roots.indexOf(secondRoot), 1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })
      await flushEffects()

      expect(getForegroundProcess).toHaveBeenCalledTimes(1)
      expect(useAppStore.getState().foregroundAgentByPaneKey).toEqual({})
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('skips active panes in the active worktree because the tab bar owns them', async () => {
    useAppStore.setState({ activeWorktreeId: 'wt-1' })
    getForegroundProcess.mockResolvedValueOnce('codex')

    await renderProbe()

    expect(getForegroundProcess).not.toHaveBeenCalled()
    expect(useAppStore.getState().foregroundAgentByPaneKey).toEqual({})
  })

  it('publishes foreground identity for non-active split panes in the active worktree', async () => {
    useAppStore.setState({
      activeWorktreeId: 'wt-1',
      tabsByWorktree: { 'wt-1': [makeTab({ title: 'zsh', launchAgent: undefined })] },
      ptyIdsByTabId: { 'tab-1': ['pty-shell', 'pty-agent'] },
      terminalLayoutsByTabId: { 'tab-1': splitPaneLayout() },
      runtimePaneTitlesByTabId: { 'tab-1': { 1: 'zsh', 2: 'Claude' } }
    })
    getForegroundProcess.mockResolvedValueOnce('codex')

    await renderProbe()

    expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-agent')
    expect(useAppStore.getState().foregroundAgentByPaneKey[SECOND_PANE_KEY]).toMatchObject({
      agent: 'codex',
      ptyId: 'pty-agent'
    })
  })

  it('skips remote-like runtime PTYs', async () => {
    useAppStore.setState({
      ptyIdsByTabId: { 'tab-1': ['remote:web-env-1@@terminal-1'] },
      terminalLayoutsByTabId: { 'tab-1': singlePaneLayout('remote:web-env-1@@terminal-1') }
    })
    getForegroundProcess.mockResolvedValueOnce('codex')

    await renderProbe()

    expect(getForegroundProcess).not.toHaveBeenCalled()
    expect(useAppStore.getState().foregroundAgentByPaneKey).toEqual({})
  })

  it('publishes foreground identity for provider-routed SSH PTYs', async () => {
    useAppStore.setState({
      ptyIdsByTabId: { 'tab-1': ['ssh:connection-1@@pty-1'] },
      terminalLayoutsByTabId: { 'tab-1': singlePaneLayout('ssh:connection-1@@pty-1') }
    })
    getForegroundProcess.mockResolvedValueOnce('codex')

    await renderProbe()

    expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('ssh:connection-1@@pty-1')
    expect(useAppStore.getState().foregroundAgentByPaneKey[PANE_KEY]).toMatchObject({
      agent: 'codex',
      ptyId: 'ssh:connection-1@@pty-1'
    })
  })

  it('skips preserved layout PTY wake hints that are no longer live', async () => {
    useAppStore.setState({
      ptyIdsByTabId: { 'tab-1': [] },
      terminalLayoutsByTabId: { 'tab-1': singlePaneLayout('pty-sleeping') }
    })
    getForegroundProcess.mockResolvedValueOnce('codex')

    await renderProbe()

    expect(getForegroundProcess).not.toHaveBeenCalled()
    expect(useAppStore.getState().foregroundAgentByPaneKey).toEqual({})
  })

  it('does not sync foreground for read-only row consumers', async () => {
    getForegroundProcess.mockResolvedValueOnce('codex')

    await renderProbe({ syncForeground: false })

    expect(getForegroundProcess).not.toHaveBeenCalled()
    expect(useAppStore.getState().foregroundAgentByPaneKey).toEqual({})
  })

  it('keeps local foreground probing when a sibling runtime tab is remote-like', async () => {
    useAppStore.setState({
      tabsByWorktree: {
        'wt-1': [
          makeTab({ title: 'Codex' }),
          makeTab({
            id: 'tab-2',
            ptyId: 'remote:web-env-1@@terminal-1',
            title: 'Claude',
            launchAgent: 'claude'
          })
        ]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1'],
        'tab-2': ['remote:web-env-1@@terminal-1']
      },
      terminalLayoutsByTabId: {
        'tab-1': singlePaneLayout('pty-1'),
        'tab-2': singlePaneLayout('remote:web-env-1@@terminal-1', SECOND_LEAF_ID)
      }
    })
    getForegroundProcess.mockResolvedValueOnce('codex')

    await renderProbe()

    expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(useAppStore.getState().foregroundAgentByPaneKey[PANE_KEY]).toMatchObject({
      agent: 'codex',
      ptyId: 'pty-1'
    })
  })

  it('publishes foreground identity for a plain visible pane without hook or title evidence', async () => {
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ title: 'zsh', launchAgent: undefined })] }
    })
    getForegroundProcess.mockResolvedValueOnce('codex')

    await renderProbe()

    expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(useAppStore.getState().foregroundAgentByPaneKey[PANE_KEY]).toMatchObject({
      agent: 'codex',
      ptyId: 'pty-1'
    })
  })

  it('publishes foreground identity for non-active split panes with agent rows', async () => {
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ title: 'zsh', launchAgent: undefined })] },
      ptyIdsByTabId: { 'tab-1': ['pty-shell', 'pty-agent'] },
      terminalLayoutsByTabId: { 'tab-1': splitPaneLayout() },
      runtimePaneTitlesByTabId: { 'tab-1': { 1: 'zsh', 2: 'Claude' } }
    })
    getForegroundProcess.mockResolvedValueOnce('zsh').mockResolvedValueOnce('codex')

    await renderProbe()

    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
    expect(getForegroundProcess).toHaveBeenNthCalledWith(1, 'pty-shell')
    expect(getForegroundProcess).toHaveBeenNthCalledWith(2, 'pty-agent')
    expect(useAppStore.getState().foregroundAgentByPaneKey[SECOND_PANE_KEY]).toMatchObject({
      agent: 'codex',
      ptyId: 'pty-agent'
    })
  })

  it('does not re-read foreground-only split pane siblings when tab title changes', async () => {
    const tab = makeTab({ title: 'zsh', launchAgent: undefined })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [tab] },
      ptyIdsByTabId: { 'tab-1': ['pty-shell', 'pty-agent'] },
      terminalLayoutsByTabId: { 'tab-1': splitPaneLayout() }
    })
    getForegroundProcess.mockResolvedValue('zsh')

    await renderProbe()

    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
    getForegroundProcess.mockClear()

    await act(async () => {
      useAppStore.setState({
        tabsByWorktree: { 'wt-1': [{ ...tab, title: 'zsh turn update' }] }
      })
    })
    await flushEffects()

    expect(getForegroundProcess).not.toHaveBeenCalled()
  })

  it('reads only the changed target when one tab title changes', async () => {
    const tabA = makeTab()
    const tabB = makeTab({
      id: 'tab-2',
      ptyId: 'pty-2',
      title: 'Claude',
      launchAgent: 'claude'
    })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [tabA, tabB] },
      ptyIdsByTabId: { 'tab-1': ['pty-1'], 'tab-2': ['pty-2'] },
      terminalLayoutsByTabId: {
        'tab-1': singlePaneLayout('pty-1'),
        'tab-2': singlePaneLayout('pty-2', SECOND_LEAF_ID)
      }
    })
    getForegroundProcess.mockResolvedValue('codex')

    await renderProbe()

    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
    expect(getForegroundProcess).toHaveBeenNthCalledWith(1, 'pty-1')
    expect(getForegroundProcess).toHaveBeenNthCalledWith(2, 'pty-2')
    getForegroundProcess.mockClear()

    await act(async () => {
      useAppStore.setState({
        tabsByWorktree: {
          'wt-1': [{ ...tabA, title: 'Codex turn update' }, tabB]
        }
      })
    })
    await flushEffects()

    expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
  })

  it('re-reads and clears cache when a live pane title changes from agent to shell', async () => {
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ title: 'zsh', launchAgent: undefined })] },
      agentStatusByPaneKey: {
        [PANE_KEY]: makeAgentStatusEntry()
      },
      runtimePaneTitlesByTabId: { 'tab-1': { 1: 'Claude' } },
      foregroundAgentByPaneKey: {
        [PANE_KEY]: { agent: 'claude', ptyId: 'pty-1', updatedAt: 1 }
      }
    })
    getForegroundProcess.mockResolvedValueOnce('claude').mockResolvedValueOnce('zsh')

    await renderProbe()
    expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')

    getForegroundProcess.mockClear()
    await act(async () => {
      useAppStore.setState({
        runtimePaneTitlesByTabId: { 'tab-1': { 1: 'zsh' } }
      })
    })
    await flushEffects()

    expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(useAppStore.getState().foregroundAgentByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('re-reads when hook lifecycle changes without a title or PTY change', async () => {
    useAppStore.setState({
      agentStatusByPaneKey: {
        [PANE_KEY]: makeAgentStatusEntry({
          state: 'working',
          stateStartedAt: 1,
          terminalTitle: 'Claude'
        })
      }
    })
    getForegroundProcess.mockResolvedValueOnce('codex').mockResolvedValueOnce('zsh')

    await renderProbe()
    expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(useAppStore.getState().foregroundAgentByPaneKey[PANE_KEY]).toMatchObject({
      agent: 'codex',
      ptyId: 'pty-1'
    })

    getForegroundProcess.mockClear()
    await act(async () => {
      useAppStore.setState({
        agentStatusByPaneKey: {
          [PANE_KEY]: makeAgentStatusEntry({
            state: 'done',
            stateStartedAt: 2,
            terminalTitle: 'Claude'
          })
        }
      })
    })
    await flushEffects()

    expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(useAppStore.getState().foregroundAgentByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('re-reads when hook agent identity changes without a state or title change', async () => {
    useAppStore.setState({
      agentStatusByPaneKey: {
        [PANE_KEY]: makeAgentStatusEntry({
          agentType: 'claude',
          state: 'working',
          stateStartedAt: 1,
          terminalTitle: 'Working'
        })
      }
    })
    getForegroundProcess.mockResolvedValueOnce('claude').mockResolvedValueOnce('codex')

    await renderProbe()
    expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')

    getForegroundProcess.mockClear()
    await act(async () => {
      useAppStore.setState({
        agentStatusByPaneKey: {
          [PANE_KEY]: makeAgentStatusEntry({
            agentType: 'codex',
            state: 'working',
            stateStartedAt: 1,
            terminalTitle: 'Working'
          })
        }
      })
    })
    await flushEffects()

    expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(useAppStore.getState().foregroundAgentByPaneKey[PANE_KEY]).toMatchObject({
      agent: 'codex',
      ptyId: 'pty-1'
    })
  })
})
