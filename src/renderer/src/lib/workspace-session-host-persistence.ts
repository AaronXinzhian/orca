import type {
  Repo,
  Worktree,
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree-id'
import {
  mergeWorkspaceSessionsFromHosts,
  splitWorkspaceSessionByHost,
  type HostSessionSlices,
  type HostIdByWorktreeId
} from './workspace-session-host-split'

export type HostPersistenceState = {
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  worktreesByRepo: Record<string, readonly Pick<Worktree, 'id' | 'repoId' | 'hostId'>[]>
}

type SessionApi = {
  get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
  patch: (args: WorkspaceSessionPatch, hostId?: ExecutionHostId) => Promise<void>
  setSync: (args: WorkspaceSessionState, hostId?: ExecutionHostId) => void
}

export type WorkspaceSessionHostRead = {
  session: WorkspaceSessionState
  runtimeHostIdByWorktreeId: Record<string, ExecutionHostId>
}

const WORKTREE_KEYED_SESSION_FIELDS = [
  'tabsByWorktree',
  'openFilesByWorktree',
  'activeFileIdByWorktree',
  'activeBrowserTabIdByWorktree',
  'activeTabTypeByWorktree',
  'activeTabIdByWorktree',
  'browserTabsByWorktree',
  'unifiedTabs',
  'tabGroups',
  'tabGroupLayouts',
  'activeGroupIdByWorktree',
  'lastVisitedAtByWorktreeId',
  'defaultTerminalTabsAppliedByWorktreeId'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function collectWorktreeIdsFromHostSession(session: WorkspaceSessionState): string[] {
  const ids = new Set<string>()
  for (const field of WORKTREE_KEYED_SESSION_FIELDS) {
    const value = session[field]
    if (isPlainRecord(value)) {
      for (const id of Object.keys(value)) {
        ids.add(id)
      }
    }
  }
  for (const id of session.activeWorktreeIdsOnShutdown ?? []) {
    ids.add(id)
  }
  return [...ids]
}

function buildRuntimeHostIdByWorktreeId(
  slices: HostSessionSlices
): Record<string, ExecutionHostId> {
  const owners: Record<string, ExecutionHostId> = {}
  for (const [hostId, slice] of nonLocalEntries(slices)) {
    for (const worktreeId of collectWorktreeIdsFromHostSession(slice)) {
      owners[worktreeId] = hostId
    }
  }
  return owners
}

/** Map a worktree to the host partition it persists under.
 *
 *  Why: only `runtime:*` worktrees are partitioned out. SSH-owned worktrees stay
 *  in the 'local' partition because the SSH flow already persists them there (in
 *  the unified blob) and separately mirrors them to each target's remote
 *  snapshot — partitioning them too would double-own that data. */
export function buildHostIdByWorktreeId(state: HostPersistenceState): HostIdByWorktreeId {
  const repoHostById = new Map<string, ExecutionHostId | null>()
  for (const repo of state.repos) {
    const hostId = getRepoExecutionHostId(repo)
    const existing = repoHostById.get(repo.id)
    // Why: repo ids can repeat across hosts; ambiguous repo-only ownership
    // must not let a runtime placeholder steal local session state.
    repoHostById.set(repo.id, existing === undefined ? hostId : existing === hostId ? hostId : null)
  }
  const repoIdByWorktreeId = new Map<string, string>()
  const runtimeHostIdByWorktreeId = new Map<string, ExecutionHostId>()
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    for (const worktree of worktrees) {
      repoIdByWorktreeId.set(worktree.id, worktree.repoId)
      const parsedWorktreeHost = parseExecutionHostId(worktree.hostId)
      if (parsedWorktreeHost?.kind === 'runtime') {
        runtimeHostIdByWorktreeId.set(worktree.id, parsedWorktreeHost.id)
      }
    }
  }

  return (worktreeId: string): ExecutionHostId => {
    const worktreeHostId = runtimeHostIdByWorktreeId.get(worktreeId)
    if (worktreeHostId) {
      return worktreeHostId
    }
    const repoId = repoIdByWorktreeId.get(worktreeId) ?? getRepoIdFromWorktreeId(worktreeId)
    const repoHostId = repoId ? repoHostById.get(repoId) : undefined
    if (!repoHostId) {
      return LOCAL_EXECUTION_HOST_ID
    }
    const parsed = parseExecutionHostId(repoHostId)
    return parsed?.kind === 'runtime' ? parsed.id : LOCAL_EXECUTION_HOST_ID
  }
}

function nonLocalEntries(slices: HostSessionSlices): [ExecutionHostId, WorkspaceSessionState][] {
  return (Object.entries(slices) as [ExecutionHostId, WorkspaceSessionState][]).filter(
    ([hostId, slice]) => hostId !== LOCAL_EXECUTION_HOST_ID && slice !== undefined
  )
}

/** Patch path of the debounced session writer: split the partial patch by owner
 *  host and patch each partition. Returns the promise for the local write so
 *  App.tsx can keep chaining the SSH remote-workspace upload off it. */
export function patchWorkspaceSessionByHost(
  api: SessionApi,
  patch: WorkspaceSessionPatch,
  state: HostPersistenceState
): Promise<void> {
  const slices = splitWorkspaceSessionByHost(
    patch as WorkspaceSessionState,
    buildHostIdByWorktreeId(state)
  )
  const local = (slices[LOCAL_EXECUTION_HOST_ID] ?? patch) as WorkspaceSessionPatch
  const localWrite = api.patch(local)
  for (const [hostId, slice] of nonLocalEntries(slices)) {
    // Why: a failed runtime-partition write must not reject the local chain.
    void api.patch(slice as WorkspaceSessionPatch, hostId).catch((err) => {
      console.warn(`[session] host partition patch failed for ${hostId}:`, err)
    })
  }
  return localWrite
}

/** Synchronous full-session split for the beforeunload / quit paths. */
export function persistWorkspaceSessionByHostSync(
  api: SessionApi,
  payload: WorkspaceSessionState,
  state: HostPersistenceState
): void {
  const slices = splitWorkspaceSessionByHost(payload, buildHostIdByWorktreeId(state))
  api.setSync(slices[LOCAL_EXECUTION_HOST_ID] ?? payload)
  for (const [hostId, slice] of nonLocalEntries(slices)) {
    api.setSync(slice, hostId)
  }
}

/** Collect the distinct runtime hosts owning any persisted repo. */
export function listKnownRuntimeHostIds(
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[]
): ExecutionHostId[] {
  const hostIds = new Set<ExecutionHostId>()
  for (const repo of repos) {
    const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
    if (parsed?.kind === 'runtime') {
      hostIds.add(parsed.id)
    }
  }
  return [...hostIds]
}

/** Boot-time hydration: fetch the local partition plus one partition per known
 *  runtime host (repos are already loaded before session hydration in App.tsx)
 *  and merge them into the unified session the hydrators expect.
 *
 *  Fail-soft: a partition whose fetch rejects is skipped — boot proceeds with
 *  the rest. Corrupt partitions never reach here; persistence zod-validates
 *  each one and falls back to defaults on the main side. */
export async function fetchWorkspaceSessionFromHosts(
  api: Pick<SessionApi, 'get'>,
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[],
  additionalRuntimeHostIds: readonly ExecutionHostId[] = []
): Promise<WorkspaceSessionState> {
  return (await fetchWorkspaceSessionWithRuntimeHostOwners(api, repos, additionalRuntimeHostIds))
    .session
}

export async function fetchWorkspaceSessionWithRuntimeHostOwners(
  api: Pick<SessionApi, 'get'>,
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[],
  additionalRuntimeHostIds: readonly ExecutionHostId[] = []
): Promise<WorkspaceSessionHostRead> {
  const slices: HostSessionSlices = {
    [LOCAL_EXECUTION_HOST_ID]: await api.get()
  }
  const runtimeHostIds = new Set<ExecutionHostId>([
    ...listKnownRuntimeHostIds(repos),
    ...additionalRuntimeHostIds
  ])
  await Promise.all(
    [...runtimeHostIds].map(async (hostId) => {
      try {
        slices[hostId] = await api.get(hostId)
      } catch (err) {
        console.warn(`[session] skipping unreadable host partition ${hostId}:`, err)
      }
    })
  )
  return {
    session: mergeWorkspaceSessionsFromHosts(slices),
    runtimeHostIdByWorktreeId: buildRuntimeHostIdByWorktreeId(slices)
  }
}
