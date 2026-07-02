// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab, TuiAgent } from '../../../shared/types'
import { useTabAgent } from './use-tab-agent'

const initialAppState = useAppStore.getInitialState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
let latestHookAgent: TuiAgent | null | undefined
const hookRoots: Root[] = []

function HookProbe({ tab }: { tab: TerminalTab }): null {
  latestHookAgent = useTabAgent(tab)
  return null
}

async function renderHookProbe(tab: TerminalTab): Promise<Root> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  hookRoots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe, { tab }))
  })
  await flushHookEffects()
  return root
}

async function rerenderHookProbe(root: Root, tab: TerminalTab): Promise<void> {
  await act(async () => {
    root.render(createElement(HookProbe, { tab }))
  })
  await flushHookEffects()
}

async function flushHookEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function singlePaneLayout(ptyId: string, leafId = LEAF_ID): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: {
      [leafId]: ptyId
    }
  }
}

describe('useTabAgent foreground cache', () => {
  const originalApi = window.api
  const getForegroundProcess = vi.fn()
  const baseTab: TerminalTab = {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    launchAgent: 'codex'
  }

  beforeEach(() => {
    latestHookAgent = undefined
    getForegroundProcess.mockReset()
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      agentStatusByPaneKey: {},
      terminalLayoutsByTabId: { 'tab-1': singlePaneLayout('pty-1') }
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
    hookRoots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
    window.api = originalApi
  })

  it('publishes recognized foreground agent identity for the active pane', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    getForegroundProcess.mockResolvedValueOnce('codex')

    await renderHookProbe({ ...baseTab, launchAgent: 'claude' })

    expect(latestHookAgent).toBe('codex')
    expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]).toMatchObject({
      agent: 'codex',
      ptyId: 'pty-1'
    })
    expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
  })

  it('refreshes timestamp when the same foreground verdict is confirmed again', async () => {
    vi.useFakeTimers()
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    getForegroundProcess.mockResolvedValue('codex')

    try {
      vi.setSystemTime(1_000)
      const root = await renderHookProbe(baseTab)
      const firstCache = useAppStore.getState().foregroundAgentByPaneKey
      const firstEntry = firstCache[paneKey]

      vi.setSystemTime(2_000)
      await rerenderHookProbe(root, { ...baseTab, title: 'Codex turn update' })

      expect(getForegroundProcess).toHaveBeenCalledTimes(2)
      expect(useAppStore.getState().foregroundAgentByPaneKey).not.toBe(firstCache)
      expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]).not.toBe(firstEntry)
      expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]).toMatchObject({
        agent: 'codex',
        ptyId: 'pty-1',
        updatedAt: 2_000
      })
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('keeps foreground cache without wall-clock expiry until a clear signal arrives', async () => {
    vi.useFakeTimers()
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    getForegroundProcess.mockResolvedValueOnce('codex')

    try {
      await renderHookProbe(baseTab)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      })
      await flushHookEffects()

      expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]).toMatchObject({
        agent: 'codex',
        ptyId: 'pty-1'
      })
      expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('clears foreground cache when a later shell foreground is observed', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    getForegroundProcess.mockResolvedValueOnce('codex').mockResolvedValueOnce('zsh')

    const root = await renderHookProbe(baseTab)
    expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]?.agent).toBe('codex')

    await rerenderHookProbe(root, { ...baseTab, title: 'zsh' })

    expect(latestHookAgent).toBeNull()
    expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]).toBeUndefined()
  })

  it('clears foreground cache when a later unknown foreground follows an agent signal', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    getForegroundProcess.mockResolvedValueOnce('codex').mockResolvedValueOnce('node')

    const root = await renderHookProbe(baseTab)
    expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]?.agent).toBe('codex')

    await rerenderHookProbe(root, { ...baseTab, title: 'node task' })

    expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]).toBeUndefined()
  })

  it('clears stale foreground cache when the foreground read fails', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    useAppStore.setState({
      foregroundAgentByPaneKey: {
        [paneKey]: { agent: 'claude', ptyId: 'pty-1', updatedAt: 1 }
      }
    })
    getForegroundProcess.mockRejectedValueOnce(new Error('foreground unavailable'))

    await renderHookProbe(baseTab)

    expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]).toBeUndefined()
  })

  it('clears foreground cache on active pane transition and unmount', async () => {
    const firstPaneKey = makePaneKey('tab-1', LEAF_ID)
    const secondPaneKey = makePaneKey('tab-1', SECOND_LEAF_ID)
    getForegroundProcess.mockResolvedValue('codex')

    const root = await renderHookProbe(baseTab)
    expect(useAppStore.getState().foregroundAgentByPaneKey[firstPaneKey]?.agent).toBe('codex')

    useAppStore.setState({
      ptyIdsByTabId: { 'tab-1': ['pty-2'] },
      terminalLayoutsByTabId: { 'tab-1': singlePaneLayout('pty-2', SECOND_LEAF_ID) }
    })
    await rerenderHookProbe(root, { ...baseTab, title: 'Codex second pane' })

    expect(useAppStore.getState().foregroundAgentByPaneKey[firstPaneKey]).toBeUndefined()
    expect(useAppStore.getState().foregroundAgentByPaneKey[secondPaneKey]?.agent).toBe('codex')

    act(() => root.unmount())
    hookRoots.splice(hookRoots.indexOf(root), 1)

    expect(useAppStore.getState().foregroundAgentByPaneKey[firstPaneKey]).toBeUndefined()
    expect(useAppStore.getState().foregroundAgentByPaneKey[secondPaneKey]).toBeUndefined()
  })

  it('clears foreground cache when the pane becomes remote-like', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    getForegroundProcess.mockResolvedValueOnce('codex')

    const root = await renderHookProbe(baseTab)
    expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]?.agent).toBe('codex')

    useAppStore.setState({
      ptyIdsByTabId: { 'tab-1': ['remote:web-env-1@@terminal-1'] },
      terminalLayoutsByTabId: { 'tab-1': singlePaneLayout('remote:web-env-1@@terminal-1') }
    })
    await rerenderHookProbe(root, {
      ...baseTab,
      ptyId: 'remote:web-env-1@@terminal-1',
      title: 'Codex remote'
    })

    expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]).toBeUndefined()
    expect(getForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
  })

  it('ignores layout PTYs that are no longer live', async () => {
    const sshPtyId = 'ssh:connection-1@@pty-1'
    useAppStore.setState({
      ptyIdsByTabId: { 'tab-1': [] },
      terminalLayoutsByTabId: { 'tab-1': singlePaneLayout(sshPtyId) }
    })

    await renderHookProbe({
      ...baseTab,
      ptyId: null,
      title: 'Claude',
      launchAgent: 'claude'
    })

    expect(getForegroundProcess).not.toHaveBeenCalled()
    expect(useAppStore.getState().foregroundAgentByPaneKey).toEqual({})
  })

  it('clears foreground cache when the terminal tab closes', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [baseTab] },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      foregroundAgentByPaneKey: {
        [paneKey]: { agent: 'codex', ptyId: 'pty-1', updatedAt: 1 }
      }
    })

    useAppStore.getState().closeTab('tab-1')

    expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]).toBeUndefined()
  })
})
