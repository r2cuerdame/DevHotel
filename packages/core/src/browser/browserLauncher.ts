import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DevHotelError } from '../errors'

export interface BrowserCandidate {
  path: string
  kind: 'chrome' | 'edge' | 'chromium' | 'custom'
}

export function findBrowserExecutable(customPath?: string): BrowserCandidate {
  if (customPath && existsSync(customPath)) {
    return { path: customPath, kind: 'custom' }
  }

  if (process.env.DEVHOTEL_BROWSER_PATH && existsSync(process.env.DEVHOTEL_BROWSER_PATH)) {
    return { path: process.env.DEVHOTEL_BROWSER_PATH, kind: 'custom' }
  }

  const platform = process.platform

  if (platform === 'win32') {
    const candidates: { path: string; kind: 'chrome' | 'edge' | 'chromium' }[] = [
      { path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', kind: 'chrome' },
      { path: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', kind: 'chrome' },
      { path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', kind: 'edge' },
      { path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', kind: 'edge' }
    ]

    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    candidates.push({
      path: join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      kind: 'chrome'
    })
    candidates.push({
      path: join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      kind: 'edge'
    })

    // Search ms-playwright folder if present
    const playwrightDir = join(localAppData, 'ms-playwright')
    if (existsSync(playwrightDir)) {
      try {
        const subdirs = readdirSync(playwrightDir).filter((d) => d.startsWith('chromium-'))
        for (const subdir of subdirs) {
          const chromePath = join(playwrightDir, subdir, 'chrome-win', 'chrome.exe')
          if (existsSync(chromePath)) {
            candidates.push({ path: chromePath, kind: 'chromium' })
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    for (const cand of candidates) {
      if (existsSync(cand.path)) {
        return cand
      }
    }
  } else if (platform === 'darwin') {
    const macCandidates: { path: string; kind: 'chrome' | 'edge' | 'chromium' }[] = [
      { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', kind: 'chrome' },
      { path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', kind: 'edge' },
      { path: '/Applications/Chromium.app/Contents/MacOS/Chromium', kind: 'chromium' }
    ]

    const playwrightDir = join(homedir(), 'Library', 'Caches', 'ms-playwright')
    if (existsSync(playwrightDir)) {
      try {
        const subdirs = readdirSync(playwrightDir).filter((d) => d.startsWith('chromium-'))
        for (const subdir of subdirs) {
          const chromePath = join(playwrightDir, subdir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
          if (existsSync(chromePath)) {
            macCandidates.push({ path: chromePath, kind: 'chromium' })
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    for (const cand of macCandidates) {
      if (existsSync(cand.path)) {
        return cand
      }
    }
  } else {
    // Linux / default
    const linuxCandidates: { path: string; kind: 'chrome' | 'edge' | 'chromium' }[] = [
      { path: '/usr/bin/google-chrome', kind: 'chrome' },
      { path: '/usr/bin/google-chrome-stable', kind: 'chrome' },
      { path: '/usr/bin/chromium', kind: 'chromium' },
      { path: '/usr/bin/chromium-browser', kind: 'chromium' },
      { path: '/snap/bin/chromium', kind: 'chromium' }
    ]

    const playwrightDir = join(homedir(), '.cache', 'ms-playwright')
    if (existsSync(playwrightDir)) {
      try {
        const subdirs = readdirSync(playwrightDir).filter((d) => d.startsWith('chromium-'))
        for (const subdir of subdirs) {
          const chromePath = join(playwrightDir, subdir, 'chrome-linux', 'chrome')
          if (existsSync(chromePath)) {
            linuxCandidates.push({ path: chromePath, kind: 'chromium' })
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    for (const cand of linuxCandidates) {
      if (existsSync(cand.path)) {
        return cand
      }
    }
  }

  throw new DevHotelError(
    'CLIENT_BROWSER_NOT_FOUND',
    'No supported Chromium browser executable was found on this host. Install Google Chrome, Chromium, or Microsoft Edge, or set DEVHOTEL_BROWSER_PATH.'
  )
}
