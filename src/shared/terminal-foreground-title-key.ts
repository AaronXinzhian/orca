import { isShellProcess } from './agent-detection'
import { resolveExplicitTerminalTitleAgentType } from './terminal-title-agent-type'
import type { TuiAgent } from './types'

export function getTitleForegroundKey(title: string, launchAgent?: TuiAgent): string {
  const titleAgent = launchAgent ? null : resolveExplicitTerminalTitleAgentType(title)
  if (titleAgent) {
    return `agent:${titleAgent}`
  }
  if (isShellProcess(title)) {
    return 'shell'
  }
  const stableTitle = title
    .trim()
    .toLowerCase()
    // Why: unknown agents may animate leading status glyphs. Keep one stable
    // key per title body so foreground polling follows real title changes.
    .replace(/^(?:[✳✦⏲◇✋⠀-⣿]+|[.*]\s)\s*/, '')
    .slice(0, 48)
  return `unknown:${stableTitle}`
}
