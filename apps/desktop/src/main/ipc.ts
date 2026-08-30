import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import {
  IPC,
  zAutostartEnabled,
  zChangeId,
  zExternalHttpUrl,
  zAndroidAction,
  zGitHubToken,
  zHostPath,
  zLogKind,
  zOptionalPreviewViewport,
  zPreviewLayout,
  zPackageSearchOffset,
  zPackageSearchQuery,
  zMcpRegistryCursor,
  zMcpRegistrySearch,
  zRendererPlanRoomInput,
  zPreviewBounds,
  zPreviewNavAction,
  zPreviewTarget,
  zPreviewVisible,
  zQuickChange,
  zRenameRoomInput,
  zRendererCloneRoomInput,
  zRendererCreateRoomInput,
  zRendererSettingInput,
  zRendererSettingKey,
  zRoomId,
  zTermId,
  zTermInput,
  zTermResize,
  type McpSetupInfo
} from '@devhotel/shared'
import {
  caTrustStatus,
  ensureCa,
  providers,
  trustCaInWindows,
  untrustCaInWindows,
  type Gateway,
  type RoomOrchestrator,
  type WindowsVmBackend
} from '@devhotel/core'
import type { PreviewManager } from './previewManager'
import type { TermManager } from './termManager'
import {
  cleanRemovalConfirmation,
  launchCleanRemovalCoordinator,
  validateCleanRemovalUninstaller,
  validateCleanRemovalTarget
} from './cleanRemoval'
import type { CleanRemovalOperation } from './cleanRemovalGate'
import { androidActionCommand } from './androidInput'
import { assertTrustedMainFrame, type RendererIpcEvent } from './ipcSecurity'
import { LinkedFolderGrants, requirePathWithinRoots } from './linkedFolderGrants'
import { makeMcpSetupInfo } from './mcpSetup'
import { searchNpmRegistry } from './npmRegistry'
import type { GitHubService } from './githubService'
import { browseMcpRegistry } from './mcpRegistry'
import { VmwareTemplateGrants } from './vmwareTemplateGrants'
import {
  detectVmwareSetup,
  openOfficialVmwareDownload
} from './vmwareSetup'

export function registerIpc(opts: {
  win: BrowserWindow
  orch: RoomOrchestrator
  windowsVm: WindowsVmBackend
  gateway: Gateway
  previews: PreviewManager
  terms: TermManager
  userData: string
  dataOwnershipId: string
  github: GitHubService
  requestRelaunch: () => void
  runCleanRemoval: (operation: CleanRemovalOperation) => Promise<boolean>
  finishCleanRemoval: () => void
}): void {
  const {
    win,
    orch,
    windowsVm,
    gateway,
    previews,
    terms,
    userData,
    dataOwnershipId,
    github,
    requestRelaunch,
    runCleanRemoval,
    finishCleanRemoval
  } = opts
  const caDir = join(userData, 'ca')
  const installDir = dirname(process.execPath)
  const packagedRendererUrl = pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).toString()
  const activeTails = new Set<string>()
  const vmwareGrants = new VmwareTemplateGrants()
  const folderGrants = new LinkedFolderGrants({
    home: app.getPath('home'),
    deniedTrees: [
      app.getPath('appData'),
      dirname(app.getPath('appData')),
      userData,
      ...(app.isPackaged ? [installDir] : []),
      process.env.APPDATA ?? '',
      process.env.LOCALAPPDATA ?? '',
      process.env.SystemRoot ?? '',
      process.env.ProgramFiles ?? '',
      process.env['ProgramFiles(x86)'] ?? '',
      process.env.ProgramData ?? ''
    ].filter(Boolean)
  })

  type TrustedHandler = (event: RendererIpcEvent, ...args: unknown[]) => unknown
  const handle = (channel: string, handler: TrustedHandler): void => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedMainFrame(event, win, app.isPackaged, process.env.ELECTRON_RENDERER_URL, packagedRendererUrl)
      return handler(event, ...args)
    })
  }
  const on = (channel: string, handler: TrustedHandler): void => {
    ipcMain.on(channel, (event, ...args) => {
      try {
        assertTrustedMainFrame(event, win, app.isPackaged, process.env.ELECTRON_RENDERER_URL, packagedRendererUrl)
        handler(event, ...args)
      } catch (err) {
        console.warn(`Rejected renderer IPC ${channel}:`, err)
      }
    })
  }

  const authorizeLinkedFolder = <T extends { sourceType: string; sourceRef: string }>(input: T): T =>
    input.sourceType === 'linked-folder'
      ? { ...input, sourceRef: folderGrants.requireApproved(input.sourceRef) }
      : input

  const send = (channel: string, ...args: unknown[]): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  orch.onEvent((e) => {
    send(IPC.evRoomEvent, e)
    if (e.kind === 'created' || e.kind === 'deleted' || e.kind === 'status') send(IPC.evRoomsChanged)
  })
  orch.onLogLine((e) => {
    if (activeTails.has(`${e.roomId}:${e.kind}`)) {
      send(IPC.evLogLine, { roomId: e.roomId, kind: e.kind, line: e.line })
    }
  })

  /* rooms */
  handle(IPC.roomsList, () => orch.listRoomsRuntime())
  handle(IPC.roomsPlan, (_event, input) => {
    const parsed = authorizeLinkedFolder(zRendererPlanRoomInput.parse(input))
    return orch.planRoom(parsed)
  })
  handle(IPC.roomsCreate, (_event, input) => {
    const parsed = authorizeLinkedFolder(zRendererCreateRoomInput.parse(input))
    const { windows, ...base } = parsed
    return orch.createRoom({
      ...base,
      actor: 'user',
      ...(windows
        ? { windows: { baseVmxPath: vmwareGrants.resolve(windows.templateGrantId), snapshot: windows.snapshot } }
        : {})
    })
  })
  handle(IPC.roomsClone, (_event, sourceRoomId, options) => {
    const parsed = zRendererCloneRoomInput.parse({ ...(options as object), sourceRoomId })
    return orch.cloneRoom({ ...parsed, actor: 'user' })
  })
  handle(IPC.roomsStart, (_event, roomId) => orch.startRoom(zRoomId.parse(roomId), 'user'))
  handle(IPC.roomsSleep, (_event, roomId) => orch.sleepRoom(zRoomId.parse(roomId), 'user'))
  handle(IPC.roomsDelete, (_event, roomId) => orch.deleteRoom(zRoomId.parse(roomId), 'user'))
  handle(IPC.roomsRestartWeb, (_event, roomId) => orch.restartWeb(zRoomId.parse(roomId), 'user'))
  handle(IPC.roomsInspect, (_event, roomId) => orch.inspectRoomRuntime(zRoomId.parse(roomId)))
  handle(IPC.roomsRename, (_event, roomId, nickname) => {
    const parsed = zRenameRoomInput.parse({ roomId, nickname })
    return orch.renameRoom(parsed.roomId, parsed.nickname)
  })
  handle(IPC.roomsComponents, (_event, roomId) => orch.components(zRoomId.parse(roomId)))
  const reauthorizeRoomSource = (roomId: unknown, selectedPath: unknown): string => {
    const safeRoomId = zRoomId.parse(roomId)
    const approved = folderGrants.requireApproved(zHostPath.parse(selectedPath))
    const recorded = orch.inspectRoom(safeRoomId).room.sourceRef
    const comparable = (value: string): string =>
      process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
    if (comparable(approved) !== comparable(recorded)) {
      throw new Error('Select the same Local Folder originally assigned to this Room')
    }
    return safeRoomId
  }
  handle(IPC.roomsSyncFromHost, (_event, roomId, selectedPath) =>
    orch.syncFromHost(reauthorizeRoomSource(roomId, selectedPath), 'user')
  )
  handle(IPC.roomsSafeResyncFromHost, (_event, roomId, selectedPath, confirmDiscardRoomChanges) =>
    orch.safeResyncFromHost(
      reauthorizeRoomSource(roomId, selectedPath),
      'user',
      confirmDiscardRoomChanges === true
    )
  )
  handle(IPC.roomsMoveIntoHotel, (_event, roomId, selectedPath) =>
    orch.moveIntoHotel(reauthorizeRoomSource(roomId, selectedPath), 'user')
  )
  handle(IPC.roomsProviders, () => providers())
  handle(IPC.roomsPickVmwareTemplate, async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'VMware virtual machine', extensions: ['vmx'] }]
    })
    const selected = result.canceled ? null : (result.filePaths[0] ?? null)
    if (!selected) return null
    const grant = vmwareGrants.grant(selected)
    try {
      const snapshots = await windowsVm.listSnapshots(grant.vmxPath)
      return { grantId: grant.grantId, label: grant.label, snapshots }
    } catch (error) {
      vmwareGrants.revoke(grant.grantId)
      throw error
    }
  })
  handle(IPC.roomsOpenWindows, (_event, roomId) => orch.openWindows(zRoomId.parse(roomId), 'user'))
  handle(IPC.roomsResetWindows, (_event, roomId) => orch.resetWindows(zRoomId.parse(roomId), 'user'))
  handle(IPC.roomsResetSyncBaseline, (_event, roomId) => orch.resetSyncBaseline(zRoomId.parse(roomId), 'user'))
  handle(IPC.roomsSetAgentHostSync, (_event, roomId, allowed) =>
    orch.setAgentHostSync(zRoomId.parse(roomId), allowed === true, 'user')
  )
  handle(IPC.packagesSearch, (_event, query, offset) =>
    searchNpmRegistry(zPackageSearchQuery.parse(query), fetch, zPackageSearchOffset.parse(offset ?? 0))
  )
  handle(IPC.hotelGithubStatus, () => github.status())
  handle(IPC.hotelGithubInstall, () => github.install())
  handle(IPC.hotelGithubConnect, (_event, token) => {
    const parsed = zGitHubToken.safeParse(token)
    if (!parsed.success) throw new Error('Enter a valid GitHub fine-grained personal access token')
    return github.connect(parsed.data)
  })
  handle(IPC.hotelGithubDisconnect, () => github.disconnect())
  handle(IPC.hotelMcpBrowse, (_event, search, cursor) =>
    browseMcpRegistry(zMcpRegistrySearch.parse(search ?? ''), cursor ? zMcpRegistryCursor.parse(cursor) : '')
  )

  /* changes / checks / diagnostics */
  handle(IPC.changesList, (_event, roomId) => orch.listChanges(zRoomId.parse(roomId)))
  handle(IPC.changesApply, (_event, roomId, change) =>
    orch.applyChange(zRoomId.parse(roomId), zQuickChange.parse(change), 'user')
  )
  handle(IPC.changesUndo, (_event, roomId, changeId) =>
    orch.undoChange(zRoomId.parse(roomId), zChangeId.parse(changeId), 'user')
  )
  handle(IPC.checksRun, (_event, roomId) => orch.runChecks(zRoomId.parse(roomId)))
  handle(IPC.diagCopy, (_event, roomId) => orch.getDiagnostic(zRoomId.parse(roomId)))

  /* logs */
  handle(IPC.logsTailStart, (_event, roomId, kind) => {
    const safeRoomId = zRoomId.parse(roomId)
    const safeKind = zLogKind.parse(kind)
    activeTails.add(`${safeRoomId}:${safeKind}`)
    return { lines: orch.logs.tail(safeRoomId, safeKind) }
  })
  handle(IPC.logsTailStop, (_event, roomId, kind) => {
    activeTails.delete(`${zRoomId.parse(roomId)}:${zLogKind.parse(kind)}`)
  })

  /* terminal */
  handle(IPC.termOpen, (event, roomId) => terms.open(zRoomId.parse(roomId), event.sender))
  on(IPC.termInput, (_event, termId, data) => {
    const parsed = zTermInput.parse({ termId, data })
    terms.input(parsed.termId, parsed.data)
  })
  on(IPC.termResize, (_event, termId, cols, rows) => {
    zTermResize.parse({ termId, cols, rows })
    terms.resize()
  })
  on(IPC.termClose, (_event, termId) => terms.close(zTermId.parse(termId)))

  /* settings / gateway / ca */
  handle(IPC.settingsGet, (_event, key) => orch.settings.get(zRendererSettingKey.parse(key)))
  handle(IPC.settingsSet, (_event, key, value) => {
    const parsed = zRendererSettingInput.parse({ key, value })
    return orch.settings.set(parsed.key, parsed.value)
  })
  handle(IPC.gatewayStatus, () => gateway.status())
  handle(IPC.caStatus, () => caTrustStatus(caDir))
  handle(IPC.caTrust, async () => {
    await ensureCa(caDir)
    await trustCaInWindows(caDir)
  })
  handle(IPC.caUntrust, () => untrustCaInWindows(caDir))

  /* app */
  handle(IPC.appVersion, () => app.getVersion())
  handle(IPC.vmwareStatus, () => detectVmwareSetup({ windowsVm }))
  handle(IPC.openVmwareDownload, () => openOfficialVmwareDownload((url) => shell.openExternal(url)))
  handle(IPC.relaunch, () => requestRelaunch())
  handle(IPC.openExternal, (_event, url) => shell.openExternal(zExternalHttpUrl.parse(url)))
  handle(IPC.openPath, async (_event, path) => {
    const allowedRoots = [
      userData,
      installDir,
      ...orch.listRooms().filter((room) => room.sourceType === 'linked-folder').map((room) => room.sourceRef)
    ]
    await shell.openPath(requirePathWithinRoots(zHostPath.parse(path), allowedRoots))
  })
  handle(IPC.pickFolder, async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    const selected = result.canceled ? null : (result.filePaths[0] ?? null)
    return selected ? folderGrants.grant(selected) : null
  })
  handle(IPC.mcpInfo, (): McpSetupInfo => {
    const serverPath = app.isPackaged
      ? join(process.resourcesPath, 'mcp', 'index.js')
      : resolve(app.getAppPath(), '..', '..', 'packages', 'mcp', 'dist', 'index.js')
    let controlPort: number | null = null
    try {
      const control = JSON.parse(readFileSync(join(userData, 'control.json'), 'utf8')) as { port: number }
      controlPort = control.port
    } catch {
      controlPort = null
    }
    return makeMcpSetupInfo({
      serverPath,
      available: existsSync(serverPath),
      executablePath: process.execPath,
      controlPort
    })
  })

  handle(IPC.footprint, () => ({
    dataDir: userData,
    installDir,
    autostart: app.getLoginItemSettings().openAtLogin
  }))
  handle(IPC.autostartSet, (_event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: zAutostartEnabled.parse(enabled), args: ['--hidden'] })
  })
  ipcMain.handle(IPC.cleanUninstall, async (event) => {
    assertTrustedMainFrame(event, win, app.isPackaged, process.env.ELECTRON_RENDERER_URL, packagedRendererUrl)

    return runCleanRemoval(async () => {
      const uninstallers = readdirSync(installDir).filter((f) => /^Uninstall.*\.exe$/i.test(f))
      if (uninstallers.length !== 1) {
        throw new Error(
          uninstallers.length === 0
            ? 'DevHotel uninstaller was not found; no Room data was removed'
            : 'Multiple DevHotel uninstallers were found; no Room data was removed'
        )
      }
      const uninstaller = uninstallers[0]!
      validateCleanRemovalUninstaller(installDir, uninstaller)
      const resolvedUserData = validateCleanRemovalTarget(userData, app.getPath('appData'), dataOwnershipId)

      const confirmation = await dialog.showMessageBox(win, cleanRemovalConfirmation(orch.listRooms().length))
      if (confirmation.response !== 1) return false

      // This closes the orchestrator mutation gate, drains admitted work, and
      // deletes one stable inventory. Failed Room ownership stays retryable.
      await orch.deleteAllRooms('user')
      try {
        if ((await caTrustStatus(caDir)) === 'trusted') await untrustCaInWindows(caDir)
      } catch (err) {
        throw new Error(`Rooms were removed, but DevHotel CA trust could not be removed: ${err instanceof Error ? err.message : String(err)}`)
      }
      app.setLoginItemSettings({ openAtLogin: false })
      // Re-check after the potentially long Room drain: never schedule a path
      // that was swapped for a junction while confirmation/cleanup was running.
      validateCleanRemovalTarget(resolvedUserData, app.getPath('appData'), dataOwnershipId)
      const resolvedUninstaller = validateCleanRemovalUninstaller(installDir, uninstaller)
      // One coordinator waits for this process (and its open DB) to exit, then
      // runs the exact silent uninstaller and removes app data only on success.
      const cleanupFailureLog = join(app.getPath('appData'), 'DevHotel-cleanup-error.log')
      await launchCleanRemovalCoordinator({
        parentPid: process.pid,
        appData: app.getPath('appData'),
        target: resolvedUserData,
        ownershipId: dataOwnershipId,
        uninstaller: resolvedUninstaller,
        failureLog: cleanupFailureLog
      })
      finishCleanRemoval()
      return true
    })
  })

  /* preview */
  /* android phone controls — pressed from the preview strip */
  handle(IPC.androidAction, (_event, roomId, action) => {
    const safeRoomId = zRoomId.parse(roomId)
    const safeAction = zAndroidAction.parse(action)
    // Room-local input: an in-Room `adb` command against the Room's own
    // emulator, never a synthetic Host click on the preview. See androidInput.ts.
    return orch.execInRoom(safeRoomId, androidActionCommand(safeAction), { timeoutMs: 20_000 }, 'user')
  })

  handle(IPC.previewSetBounds, (_event, roomId, bounds) =>
    previews.attach(zRoomId.parse(roomId), zPreviewBounds.parse(bounds))
  )
  handle(IPC.previewSetVisible, (_event, roomId, visible) =>
    previews.setVisible(zRoomId.parse(roomId), zPreviewVisible.parse(visible))
  )
  handle(IPC.previewDetach, () => previews.detach())
  handle(IPC.previewNav, (_event, roomId, action, target) =>
    previews.nav(
      zRoomId.parse(roomId),
      zPreviewNavAction.parse(action),
      target === undefined ? 'both' : zPreviewTarget.parse(target)
    )
  )
  handle(IPC.previewDevTools, (_event, roomId) => previews.toggleDevTools(zRoomId.parse(roomId)))
  handle(IPC.previewViewport, (_event, roomId, size) =>
    previews.setViewport(zRoomId.parse(roomId), zOptionalPreviewViewport.parse(size))
  )
  handle(IPC.previewLayout, (_event, roomId, layout) =>
    previews.setLayout(zRoomId.parse(roomId), zPreviewLayout.parse(layout))
  )
}
