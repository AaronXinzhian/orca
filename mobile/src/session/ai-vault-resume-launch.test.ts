import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import {
  buildMobileAiVaultResumeLaunch,
  buildMobileAiVaultResumeCommand,
  readMobileRuntimeHostPlatform,
  readMobileRuntimeTerminalWindowsShell,
  resolveMobileAiVaultResumePlatform,
  resumeAiVaultSessionInTerminal
} from './ai-vault-resume-launch'

function session(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'claude:1',
    agent: 'claude',
    sessionId: 'session 1',
    title: 'Resume me',
    cwd: '/Users/ada/repo',
    branch: 'main',
    model: null,
    filePath: '/Users/ada/.claude/session.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-06-29T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 10,
    previewMessages: [],
    resumeCommand: '',
    ...overrides
  }
}

describe('buildMobileAiVaultResumeCommand', () => {
  it('delegates POSIX command construction to the shared AI Vault builder', () => {
    expect(buildMobileAiVaultResumeCommand({ session: session(), hostPlatform: 'darwin' })).toBe(
      "cd '/Users/ada/repo' && claude --resume 'session 1'"
    )
  })

  it('uses PowerShell-safe queued command construction for default local Windows terminals', () => {
    expect(
      buildMobileAiVaultResumeCommand({
        session: session({
          agent: 'codex',
          sessionId: 'codex-1',
          cwd: 'C:\\repo app',
          codexHome: 'C:\\Users\\Ada\\.codex'
        }),
        hostPlatform: 'win32'
      })
    ).toBe(
      "Set-Location -LiteralPath 'C:\\repo app'; $env:CODEX_HOME='C:\\Users\\Ada\\.codex'; codex resume \"codex-1\""
    )
  })

  it('uses cmd wrapping when the host Windows terminal is configured as cmd', () => {
    const command = buildMobileAiVaultResumeCommand({
      session: session({
        agent: 'codex',
        sessionId: 'codex-1',
        cwd: 'C:\\repo app',
        codexHome: 'C:\\Users\\Ada\\.codex'
      }),
      hostPlatform: 'win32',
      hostTerminalWindowsShell: 'cmd.exe'
    })
    expect(command).toContain('cmd /d /s /c')
    expect(command).toContain('cd /d ""C:\\repo app""')
    expect(command).toContain('set ""CODEX_HOME=C:\\Users\\Ada\\.codex""')
    expect(command).toContain('codex resume ""codex-1""')
  })

  it('uses POSIX command construction and converts Codex home for WSL targets', () => {
    expect(
      buildMobileAiVaultResumeCommand({
        session: session({
          agent: 'codex',
          sessionId: 'codex-1',
          cwd: '/home/ada/repo',
          codexHome: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex'
        }),
        hostPlatform: 'linux'
      })
    ).toBe("cd '/home/ada/repo' && CODEX_HOME='/home/ada/.codex' codex resume 'codex-1'")
  })

  it('passes command overrides through to the shared builder', () => {
    expect(
      buildMobileAiVaultResumeCommand({
        session: session({ sessionId: 'abc' }),
        hostPlatform: 'linux',
        commandOverride: 'claude-dev'
      })
    ).toBe("cd '/Users/ada/repo' && claude-dev --resume 'abc'")
  })
})

describe('buildMobileAiVaultResumeLaunch', () => {
  it('uses shared TUI startup planning for default args, env, and launch config', () => {
    const launch = buildMobileAiVaultResumeLaunch({
      session: session({
        agent: 'claude',
        sessionId: 'abc 123',
        cwd: '/Users/ada/repo'
      }),
      hostPlatform: 'darwin',
      settings: {
        agentCmdOverrides: { claude: 'claude-dev' },
        agentDefaultArgs: { claude: '--model opus' },
        agentDefaultEnv: { claude: { ANTHROPIC_BASE_URL: 'http://localhost:3000' } }
      }
    })
    expect(launch.command).toBe(
      "cd '/Users/ada/repo' && claude-dev '--model' 'opus' '--resume' 'abc 123'"
    )
    expect(launch.env).toEqual({ ANTHROPIC_BASE_URL: 'http://localhost:3000' })
    expect(launch.launchAgent).toBe('claude')
    expect(launch.launchConfig).toEqual({
      agentCommand: "claude-dev '--model' 'opus'",
      agentArgs: '--model opus',
      agentEnv: { ANTHROPIC_BASE_URL: 'http://localhost:3000' }
    })
  })
})

describe('resumeAiVaultSessionInTerminal', () => {
  it('creates a fresh terminal and sends the command with Enter', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: { tab: { type: 'terminal', id: 'tab-1', terminal: 'pty-1', title: 'Terminal' } }
      })
      .mockResolvedValueOnce({ ok: true, result: { send: { accepted: true } } })

    await expect(
      resumeAiVaultSessionInTerminal({ sendRequest }, 'worktree-1', {
        command: 'claude --resume abc',
        env: { ANTHROPIC_BASE_URL: 'http://localhost:3000' },
        launchConfig: {
          agentCommand: 'claude',
          agentArgs: '',
          agentEnv: { ANTHROPIC_BASE_URL: 'http://localhost:3000' }
        },
        launchAgent: 'claude',
        clientMutationId: 'resume-1'
      })
    ).resolves.toMatchObject({ id: 'tab-1', terminal: 'pty-1' })
    expect(sendRequest).toHaveBeenNthCalledWith(1, 'session.tabs.createTerminal', {
      worktree: 'id:worktree-1',
      env: { ANTHROPIC_BASE_URL: 'http://localhost:3000' },
      launchConfig: {
        agentCommand: 'claude',
        agentArgs: '',
        agentEnv: { ANTHROPIC_BASE_URL: 'http://localhost:3000' }
      },
      launchAgent: 'claude',
      clientMutationId: 'resume-1'
    })
    expect(sendRequest).toHaveBeenNthCalledWith(2, 'terminal.send', {
      terminal: 'pty-1',
      text: 'claude --resume abc',
      enter: true
    })
  })

  it('throws when terminal creation fails', async () => {
    const sendRequest = vi.fn().mockResolvedValueOnce({
      ok: false,
      error: { message: 'no terminal' }
    })
    await expect(
      resumeAiVaultSessionInTerminal({ sendRequest }, 'worktree-1', { command: 'command' })
    ).rejects.toThrow('no terminal')
  })

  it('throws when the created terminal response is malformed', async () => {
    const sendRequest = vi.fn().mockResolvedValueOnce({ ok: true, result: { tab: { id: 'x' } } })
    await expect(
      resumeAiVaultSessionInTerminal({ sendRequest }, 'worktree-1', { command: 'command' })
    ).rejects.toThrow('Created terminal response was invalid')
  })

  it('throws when terminal send fails or is locked', async () => {
    const failedSend = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: { tab: { type: 'terminal', id: 'tab-1', terminal: 'pty-1' } }
      })
      .mockResolvedValueOnce({ ok: false, error: { message: 'send failed' } })
    await expect(
      resumeAiVaultSessionInTerminal({ sendRequest: failedSend }, 'worktree-1', {
        command: 'command'
      })
    ).rejects.toThrow('send failed')

    const lockedSend = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: { tab: { type: 'terminal', id: 'tab-1', terminal: 'pty-1' } }
      })
      .mockResolvedValueOnce({ ok: true, result: { send: { accepted: false } } })
    await expect(
      resumeAiVaultSessionInTerminal({ sendRequest: lockedSend }, 'worktree-1', {
        command: 'command'
      })
    ).rejects.toThrow('Terminal input is locked')
  })
})

describe('resume platform helpers', () => {
  it('reads a valid host platform from status.get', () => {
    expect(readMobileRuntimeHostPlatform({ hostPlatform: 'win32' })).toBe('win32')
    expect(readMobileRuntimeHostPlatform({ hostPlatform: 'not-a-platform' })).toBeNull()
  })

  it('reads the host Windows terminal shell from status.get', () => {
    expect(readMobileRuntimeTerminalWindowsShell({ terminalWindowsShell: 'wsl.exe' })).toBe(
      'wsl.exe'
    )
    expect(readMobileRuntimeTerminalWindowsShell({ terminalWindowsShell: '' })).toBeNull()
  })

  it('uses Linux/POSIX construction for SSH targets and host platform for local targets', () => {
    expect(resolveMobileAiVaultResumePlatform('ssh', 'win32')).toBe('linux')
    expect(resolveMobileAiVaultResumePlatform('local', 'darwin')).toBe('darwin')
    expect(
      resolveMobileAiVaultResumePlatform(
        'local',
        'win32',
        '\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo'
      )
    ).toBe('linux')
    expect(resolveMobileAiVaultResumePlatform('local', 'win32', 'C:\\repo', 'linux')).toBe('linux')
    expect(resolveMobileAiVaultResumePlatform('runtime', 'linux')).toBeNull()
  })
})
