import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import { assertTrustedMainFrame } from './ipcSecurity'
import { LinkedFolderGrants, requirePathWithinRoots } from './linkedFolderGrants'

const roots: string[] = []

function sandbox(): { root: string; home: string; project: string; denied: string } {
  const root = mkdtempSync(join(tmpdir(), 'devhotel-host-boundary-'))
  roots.push(root)
  const home = join(root, 'profiles', 'current')
  const project = join(home, 'projects', 'demo')
  const denied = join(home, 'appdata')
  mkdirSync(project, { recursive: true })
  mkdirSync(denied, { recursive: true })
  writeFileSync(join(project, 'package.json'), '{}')
  return { root, home, project, denied }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('trusted renderer boundary', () => {
  it('accepts only the registered main frame and trusted renderer URL', () => {
    const frame = { url: 'file:///app/renderer/index.html' }
    const webContents = { mainFrame: frame }
    const win = { webContents } as unknown as BrowserWindow
    const event = { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent

    expect(() => assertTrustedMainFrame(event, win, true, undefined, frame.url)).not.toThrow()
    expect(() =>
      assertTrustedMainFrame(
        { sender: webContents, senderFrame: { url: frame.url } } as unknown as IpcMainInvokeEvent,
        win,
        true,
        undefined,
        frame.url
      )
    ).toThrow(/trusted DevHotel main frame/)
    expect(() =>
      assertTrustedMainFrame(
        { sender: webContents, senderFrame: { ...frame, url: 'https://evil.example' } } as unknown as IpcMainInvokeEvent,
        { webContents: { mainFrame: { ...frame, url: 'https://evil.example' } } } as unknown as BrowserWindow,
        true,
        undefined,
        frame.url
      )
    ).toThrow(/trusted DevHotel main frame/)
  })
})

describe('linked-folder grants', () => {
  it('accepts only the exact canonical folder approved by the native picker', () => {
    const { home, project, denied } = sandbox()
    const sibling = join(home, 'projects', 'other')
    const child = join(project, 'src')
    mkdirSync(sibling, { recursive: true })
    mkdirSync(child)
    const grants = new LinkedFolderGrants({ home, deniedTrees: [denied] })

    expect(grants.grant(project)).toBe(realpathSync.native(project))
    expect(grants.requireApproved(project)).toBe(realpathSync.native(project))
    expect(() => grants.requireApproved(sibling)).toThrow(/not approved/)
    expect(() => grants.requireApproved(child)).toThrow(/not approved/)
  })

  it('rejects drive/profile/application roots and reparse-point escapes', () => {
    const { root, home, project, denied } = sandbox()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const grants = new LinkedFolderGrants({ home, deniedTrees: [denied] })

    expect(() => grants.grant(parse(project).root)).toThrow(/too broad/)
    expect(() => grants.grant(home)).toThrow(/user profile/)
    expect(() => grants.grant(denied)).toThrow(/Protected application or system data/)

    symlinkSync(outside, join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => grants.grant(project)).toThrow(/symbolic link or junction/)
  })

  it('allows shell paths only within an explicit existing root', () => {
    const { root, project } = sandbox()
    const inside = join(project, 'src')
    const executable = join(project, 'tool.exe')
    const outside = join(root, 'outside')
    mkdirSync(inside)
    mkdirSync(outside)
    writeFileSync(executable, 'not executable')

    expect(requirePathWithinRoots(inside, [project])).toBe(realpathSync.native(inside))
    expect(() => requirePathWithinRoots(outside, [project])).toThrow(/outside/)
    expect(() => requirePathWithinRoots(executable, [project])).toThrow(/directories/)
  })
})
