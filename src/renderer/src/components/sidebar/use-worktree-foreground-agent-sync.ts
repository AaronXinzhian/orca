import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { recognizeAgentProcess } from '../../../../shared/agent-process-recognition'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import {
  collectForegroundSyncTargets,
  targetKey,
  type ForegroundSyncTarget
} from './worktree-foreground-sync-targets'

const HELPER_FOREGROUND_RETRY_DELAYS_MS = [250, 1250, 3500, 750] as const
let nextForegroundSyncOwnerId = 0
const foregroundSyncOwnersByPaneKey = new Map<string, Set<string>>()
const foregroundReadTargetKeyByPaneKey = new Map<string, string>()

function addForegroundSyncOwner(paneKey: string, ownerId: string): void {
  const owners = foregroundSyncOwnersByPaneKey.get(paneKey)
  if (owners) {
    owners.add(ownerId)
    return
  }
  foregroundSyncOwnersByPaneKey.set(paneKey, new Set([ownerId]))
}

function releaseForegroundSyncOwner(paneKey: string, ownerId: string): boolean {
  const owners = foregroundSyncOwnersByPaneKey.get(paneKey)
  if (!owners) {
    return true
  }
  owners.delete(ownerId)
  if (owners.size > 0) {
    return false
  }
  foregroundSyncOwnersByPaneKey.delete(paneKey)
  foregroundReadTargetKeyByPaneKey.delete(paneKey)
  return true
}

function claimForegroundRead(paneKey: string, expectedKey: string): boolean {
  if (foregroundReadTargetKeyByPaneKey.get(paneKey) === expectedKey) {
    return false
  }
  foregroundReadTargetKeyByPaneKey.set(paneKey, expectedKey)
  return true
}

function isForegroundReadCurrent(paneKey: string, expectedKey: string): boolean {
  return (
    foregroundReadTargetKeyByPaneKey.get(paneKey) === expectedKey &&
    (foregroundSyncOwnersByPaneKey.get(paneKey)?.size ?? 0) > 0
  )
}

export function useWorktreeForegroundAgentSync(
  worktreeId: string,
  tabs: TerminalTab[] | undefined,
  liveEntries: readonly AgentStatusEntry[],
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>,
  ptyIdsByTabId: Record<string, string[]>,
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>,
  active: boolean
): void {
  const isActiveWorktree = useAppStore((s) => (active ? s.activeWorktreeId === worktreeId : false))
  const setForegroundAgentForPane = useAppStore((s) => s.setForegroundAgentForPane)
  const clearForegroundAgentForPane = useAppStore((s) => s.clearForegroundAgentForPane)
  const targetKeysByPaneKeyRef = useRef(new Map<string, string>())
  const retryTimersByPaneKeyRef = useRef(new Map<string, number[]>())
  const ownerIdRef = useRef<string | null>(null)
  if (ownerIdRef.current === null) {
    ownerIdRef.current = `worktree-foreground-sync:${++nextForegroundSyncOwnerId}`
  }
  const ownerId = ownerIdRef.current
  const targets = useMemo(
    () =>
      collectForegroundSyncTargets({
        liveEntries,
        ptyIdsByTabId,
        runtimePaneTitlesByTabId,
        skipActivePaneTargets: isActiveWorktree,
        tabs,
        terminalLayoutsByTabId
      }),
    [
      isActiveWorktree,
      liveEntries,
      ptyIdsByTabId,
      runtimePaneTitlesByTabId,
      tabs,
      terminalLayoutsByTabId
    ]
  )
  const shouldSync = active
  const targetFingerprint = useMemo(() => targets.map(targetKey).join('\u0001'), [targets])
  const cleanupCurrentTargets = useCallback(() => {
    const retryTimersByPaneKey = retryTimersByPaneKeyRef.current
    const targetKeysByPaneKey = targetKeysByPaneKeyRef.current
    for (const paneKey of targetKeysByPaneKey.keys()) {
      if (releaseForegroundSyncOwner(paneKey, ownerId)) {
        for (const timer of retryTimersByPaneKey.get(paneKey) ?? []) {
          window.clearTimeout(timer)
        }
        clearForegroundAgentForPane(paneKey)
      }
    }
    retryTimersByPaneKey.clear()
    targetKeysByPaneKey.clear()
  }, [clearForegroundAgentForPane, ownerId])

  useEffect(() => {
    const clearTimersForPane = (paneKey: string): void => {
      for (const timer of retryTimersByPaneKeyRef.current.get(paneKey) ?? []) {
        window.clearTimeout(timer)
      }
      retryTimersByPaneKeyRef.current.delete(paneKey)
    }
    const removePane = (paneKey: string): void => {
      targetKeysByPaneKeyRef.current.delete(paneKey)
      // Why: pinned and grouped WorktreeCards can mount duplicate readers for
      // the same pane; one owner unmounting must not erase the survivor's cache
      // or cancel its pending bounded helper retry.
      if (releaseForegroundSyncOwner(paneKey, ownerId)) {
        clearTimersForPane(paneKey)
        clearForegroundAgentForPane(paneKey)
      }
    }
    const readForeground = (
      target: ForegroundSyncTarget,
      expectedKey: string,
      retryIndex = 0,
      allowCurrentTargetRead = false
    ): void => {
      if (!allowCurrentTargetRead && !claimForegroundRead(target.paneKey, expectedKey)) {
        return
      }
      if (allowCurrentTargetRead && !isForegroundReadCurrent(target.paneKey, expectedKey)) {
        return
      }
      window.api.pty
        .getForegroundProcess(target.ptyId)
        .then((process) => {
          applyForegroundProcess(target, expectedKey, process, retryIndex)
        })
        .catch(() => {
          if (isForegroundReadCurrent(target.paneKey, expectedKey)) {
            clearForegroundAgentForPane(target.paneKey)
          }
        })
    }
    const scheduleRetry = (
      target: ForegroundSyncTarget,
      expectedKey: string,
      retryIndex: number
    ): void => {
      const delay = HELPER_FOREGROUND_RETRY_DELAYS_MS[retryIndex]
      if (delay === undefined) {
        return
      }
      const timer = window.setTimeout(
        () => readForeground(target, expectedKey, retryIndex + 1, true),
        delay
      )
      retryTimersByPaneKeyRef.current.set(target.paneKey, [
        ...(retryTimersByPaneKeyRef.current.get(target.paneKey) ?? []),
        timer
      ])
    }
    const applyForegroundProcess = (
      target: ForegroundSyncTarget,
      expectedKey: string,
      process: string | null,
      retryIndex: number
    ): void => {
      if (!isForegroundReadCurrent(target.paneKey, expectedKey)) {
        return
      }
      const recognized = recognizeAgentProcess(process)
      if (recognized) {
        setForegroundAgentForPane(target.paneKey, {
          agent: recognized.agent,
          ptyId: target.ptyId,
          updatedAt: Date.now()
        })
        return
      }
      clearForegroundAgentForPane(target.paneKey)
      if (process && target.launchAgent) {
        scheduleRetry(target, expectedKey, retryIndex)
      }
    }

    if (!shouldSync) {
      for (const paneKey of targetKeysByPaneKeyRef.current.keys()) {
        removePane(paneKey)
      }
      return
    }
    const previousKeys = targetKeysByPaneKeyRef.current
    const nextTargets = new Map(targets.map((target) => [target.paneKey, target] as const))
    const nextKeys = new Map(targets.map((target) => [target.paneKey, targetKey(target)] as const))
    for (const paneKey of previousKeys.keys()) {
      if (!nextTargets.has(paneKey)) {
        removePane(paneKey)
      }
    }
    targetKeysByPaneKeyRef.current = nextKeys
    for (const target of targets) {
      addForegroundSyncOwner(target.paneKey, ownerId)
      const nextKey = nextKeys.get(target.paneKey)!
      if (previousKeys.get(target.paneKey) === nextKey) {
        continue
      }
      clearTimersForPane(target.paneKey)
      readForeground(target, nextKey)
    }
    // targetFingerprint is the stable representation of target foreground inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    clearForegroundAgentForPane,
    ownerId,
    setForegroundAgentForPane,
    shouldSync,
    targetFingerprint
  ])

  useEffect(() => {
    return cleanupCurrentTargets
  }, [cleanupCurrentTargets])
}
