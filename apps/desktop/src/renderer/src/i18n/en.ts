export const en = {
  // Common actions
  'common.cancel': 'Cancel',
  'common.back': 'Back',
  'common.close': 'Close',
  'common.copy': 'Copy',
  'common.apply': 'Apply',
  'common.applying': 'Applying…',
  'common.restart': 'Restart',
  'common.undo': 'Undo',
  'common.clear': 'Clear',

  // Room status
  'status.preparing': 'Preparing',
  'status.running': 'Running',
  'status.ready': 'Ready',
  'status.sleeping': 'Sleeping',
  'status.attention': 'Needs attention',
  'status.broken': 'Broken',

  // Busy labels
  'busy.waking': 'Waking room…',
  'busy.sleeping': 'Putting room to sleep…',
  'busy.restarting': 'Restarting…',
  'busy.deleting': 'Checking out…',

  // Toasts
  'toast.checkInFailed': 'Check-in failed: {message}',
  'toast.roomDeleted': 'Room deleted — {size} reclaimed',
  'toast.changeFailed': '{title} failed — {detail}',
  'toast.seeDiagnostics': 'see diagnostics',
  'toast.undone': 'Undone: {title}',
  'toast.diagCopied': 'Diagnostic copied — secrets redacted',
  'toast.copied': '{what} copied',
  'toast.caTrusted': 'DevHotel Local CA trusted for your Windows user',
  'toast.caUntrusted': 'DevHotel Local CA removed from Windows trust',

  // Relative time
  'time.justNow': 'just now',
  'time.minutesAgo': '{n}m ago',
  'time.hoursAgo': '{n}h ago',
  'time.daysAgo': '{n}d ago',

  // Lobby
  'lobby.gatewayTitle': 'Local gateway',
  'lobby.gatewayOn': 'Gateway on {ports}',
  'lobby.gatewayOffline': 'Gateway offline',
  'lobby.settings': 'Settings',
  'lobby.quietTitle': 'The lobby is quiet',
  'lobby.quietHint': 'Check in your first project — pick a GitHub repository or a local folder.',
  'lobby.newRoom': 'New Room',

  // New room wizard
  'wizard.sourceGit': 'GitHub repository',
  'wizard.sourceGitHint': 'Cloned into the room',
  'wizard.sourceFolder': 'Local folder',
  'wizard.sourceFolderHint': 'Linked — your files stay put',
  'wizard.sourceEmpty': 'Empty room',
  'wizard.sourceEmptyHint': 'Start from nothing',
  'wizard.repoUrl': 'Repository URL',
  'wizard.projectFolder': 'Project folder',
  'wizard.browse': 'Browse…',
  'wizard.projectName': 'Project name',
  'wizard.auto': 'auto',
  'wizard.nickname': 'Room nickname',
  'wizard.analyzing': 'Analyzing…',
  'wizard.analyze': 'Analyze project',
  'wizard.planTitle': 'Room plan — {project} / {nickname}',
  'wizard.enable': 'Enable',
  'wizard.preparingRoom': 'Preparing room…',
  'wizard.checkIn': 'Check in',

  // Shared field labels
  'label.project': 'Project',
  'label.runtime': 'Runtime',
  'label.packageManager': 'Package manager',
  'label.startCommand': 'Start command',
  'label.internalPort': 'Internal port',
  'label.domain': 'Domain',
  'label.status': 'Status',
  'label.source': 'Source',

  // Settings
  'settings.title': 'Settings',
  'settings.language': 'Language',
  'settings.mcpTitle': 'MCP — let agents use rooms',
  'settings.mcpDesc':
    "The DevHotel MCP server lets Claude Code and other agents create, run, and change rooms instead of installing things on your PC. Every agent change shows up in the room's Changes list and can be undone.",
  'settings.mcpMissingPre': 'MCP server script not found — run',
  'settings.mcpMissingPost': 'in the repo first.',
  'settings.claudeCommand': 'Claude Code — one command',
  'settings.mcpClientConfig': 'Any MCP client — mcpServers config',
  'settings.mcpPortNote': 'The MCP server talks to this app on 127.0.0.1:{port} — DevHotel must be running.',
  'settings.mcpRunningNote': 'DevHotel must be running for MCP tools to work.',
  'settings.whatCommand': 'Command',
  'settings.whatConfig': 'Config',
  'settings.httpsTitle': 'HTTPS certificates',
  'settings.httpsDesc':
    "Room previews trust DevHotel's local certificates automatically. Trust the DevHotel Local CA in Windows to avoid warnings in external browsers.",
  'settings.caStatus': 'CA status:',
  'settings.caTrusted': 'trusted',
  'settings.caUntrusted': 'not trusted',
  'settings.caMissing': 'not created yet',
  'settings.trustCa': 'Trust CA',
  'settings.untrustCa': 'Remove trust',
  'settings.about': 'About',
  'settings.aboutLine': 'DevHotel {version} — every project gets its own room.',

  // Room view
  'room.notFound': 'Room not found',
  'room.asleepHint': 'This room is asleep. Everything is kept as you left it.',
  'room.wakeRoom': 'Wake room',
  'room.preparingHint': 'Preparing the room…',
  'room.unreachableHint': '{status} — the site is not reachable. Open Diagnostics to see which check failed.',
  'room.openDiagnostics': 'Open diagnostics',

  // Browser bar
  'bar.backToLobby': 'Back to Lobby',
  'bar.forward': 'Forward',
  'bar.reload': 'Reload',
  'bar.sleep': 'Sleep',
  'bar.wake': 'Wake',
  'bar.start': 'Start',
  'bar.roomDetails': 'Room details',
  'bar.more': 'More',
  'bar.openExternal': 'Open in default browser',
  'bar.openSourceFolder': 'Open source folder',
  'bar.deleteRoom': 'Delete room…',
  'bar.deleteConfirm':
    "Delete {project} / {nickname}?\n\nThis removes the room's environment, dependencies and data. Sleeping keeps everything — deleting does not.",

  // Detail panel tabs
  'tabs.overview': 'Overview',
  'tabs.stack': 'Stack',
  'tabs.services': 'Services',
  'tabs.logs': 'Logs',
  'tabs.changes': 'Changes',
  'tabs.diagnostics': 'Diagnostics',
  'tabs.console': 'Console',

  // Overview tab
  'overview.emptyRoom': 'empty room',
  'overview.lastChange': 'Last change',
  'overview.health': 'Health',
  'overview.checksFailing': 'Some checks are failing — see the Diagnostics tab.',

  // Stack tab
  'stack.changing': 'Changing…',
  'stack.changeNode': 'Change {from} → {to}',
  'stack.domainHintPre': 'Domains end in',
  'stack.domainHintPost': '— no hosts file changes needed.',
  'stack.httpsOn': 'Turn HTTPS on',
  'stack.httpsOff': 'Turn HTTPS off',
  'stack.dependencies': 'Dependencies',
  'stack.install': 'Install',
  'stack.installing': 'Installing…',
  'stack.cleanReinstall': 'Clean reinstall',
  'stack.reinstalling': 'Reinstalling…',
  'stack.caHintPre':
    'The DevHotel preview trusts room certificates automatically. To avoid warnings in external browsers,',
  'stack.caHintLink': 'trust the DevHotel Local CA',
  'stack.caHintPost': '(you can remove it any time in Windows certificate manager).',

  // Services tab
  'services.webProcess': 'Web process',
  'services.processMeta': '{status} · internal port {port}',
  'services.databases': 'Databases',

  // Logs tab
  'logs.web': 'Web',
  'logs.empty': 'No output yet.',

  // Changes tab
  'changes.empty': 'No changes yet. Changes made from Stack, fixes, and agent actions appear here.',
  'changes.undone': 'undone',
  'changes.rolledBack': 'rolled back',
  'changes.failed': 'failed',
  'changes.agent': 'agent',
  'changes.undoUnavailable': 'Undo unavailable',

  // Diagnostics tab
  'diag.runChecks': 'Run checks',
  'diag.checking': 'Checking…',
  'diag.copyDiagnostic': 'Copy diagnostic',
  'diag.emptyHint': 'Run checks to inspect this room from backend to HTTP response.',
  'diag.fix': 'Fix',
  'diag.copyHint':
    'Copy diagnostic produces a redacted bundle — passwords, tokens and .env values are masked — ready to paste into an issue or an LLM.',
  'diag.stepBackend': 'Isolation backend',
  'diag.stepMetadata': 'Room metadata',
  'diag.stepEnv': 'Environment variables',
  'diag.stepGateway': 'Gateway route',
  'diag.stepHttps': 'DNS / HTTPS',
  'diag.stepHttp': 'HTTP response',

  // Console tab
  'console.sessionEnded': '[session ended]',
  'console.openFailed': 'Could not open a terminal in this room: {error}',
  'console.mustBeAwake': 'The room must be awake for a terminal session.',
  'console.shellHint': 'This shell runs inside the room, not on your PC. Installs and tools stay in the room.',
  'console.openRoomData': 'Open room data (manifest · logs)',

  // Panel redesign / rename / android
  'tabs.activity': 'Activity',
  'tabs.health': 'Health',
  'overview.openInBrowser': 'Open in browser',
  'bar.rename': 'Rename room…',
  'rename.title': 'Rename room',
  'rename.save': 'Save',
  'wizard.sourceAndroid': 'Android app',
  'wizard.sourceAndroidHint': 'JDK + Gradle room — builds APKs',
  'tabs.site': 'Site',

  // Android rooms · services · viewport · host footprint
  'wizard.sourceWindows': 'Windows app',
  'wizard.sourceWindowsHint': 'On the roadmap — after Android',
  'android.buildApk': 'Build APK',
  'android.building': 'Building…',
  'android.buildCommand': 'Build command',
  'android.apkHint': 'APKs land under app/build/outputs/apk in the project.',
  'android.pill': '{project} / {nickname} — Android',
  'bar.devtools': 'Toggle DevTools (F12)',
  'viewport.title': 'Preview viewport',
  'viewport.auto': 'Auto',
  'services.backup': 'Backup',
  'services.remove': 'Remove',
  'services.addPostgres': '+ PostgreSQL 17',
  'services.addRedis': '+ Redis 8',
  'services.removeConfirm':
    'Remove {service} from this room?\n\nA safety backup is taken automatically before removal — Undo restores the service with its data.',
  'services.servicesHint':
    'Services live inside the room at localhost:5432 / 6379 — credentials devhotel / devhotel, database devhotel. Backups land in the room data folder (Console → open room data).',
  'footprint.title': 'Host footprint',
  'footprint.app': 'The app itself in %LOCALAPPDATA%\\Programs — uninstall via Windows Apps.',
  'footprint.appData': 'App data — room manifests, logs and backups — in %APPDATA%\\DevHotel. Delete the folder to remove it.',
  'footprint.docker':
    "Rooms' runtimes, dependencies and databases live only in Docker volumes and images — removed per room on delete, fully via Docker.",
  'footprint.ca': 'Optional: the DevHotel Local CA in the Windows user certificate store — use Remove trust above.',
  'footprint.autostart': 'Optional: a Start-with-Windows entry — toggle it from the tray icon.',
  'footprint.nothingElse': 'Nothing else is installed on the host — no global Node, npm, JDK, or SDKs.',
  'tabs.system': 'System',
  'system.envVars': 'Environment variables',
  'system.addVar': '+ Variable',
  'system.cpus': 'CPU limit',
  'system.memory': 'Memory limit',
  'system.unlimited': 'Unlimited',
  'system.timezone': 'Timezone',
  'system.hint': 'Applying restarts the room process. Every setting can be undone from Changes.',
  'footprint.openData': 'Open data folder',
  'footprint.openApp': 'Open install folder',
  'footprint.cleanUninstall': 'Uninstall & remove everything…',
  'footprint.cleanUninstallConfirm': 'This deletes ALL rooms (containers, volumes, databases), removes CA trust and autostart, erases app data, and launches the uninstaller. This cannot be undone. Continue?',
  'footprint.cleaning': 'Cleaning up…',
  'android.lastBuild': 'Latest build',
  'android.openApkFolder': 'Open APK folder',
  'android.run': 'Build & run',
  'android.launching': 'Launching…',
  'android.emulatorHint': 'The Site page shows the emulator screen — the app appears there after Build & run.',
  'services.backupsTitle': 'Backups',
  'services.restore': 'Restore',
  'services.restoreConfirm': 'Restore this backup? Current data is safety-backed-up first, and the restore itself can be undone.'
} as const
