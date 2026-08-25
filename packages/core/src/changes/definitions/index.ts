import type { ChangeEngine } from '../engine'
import { nodeVersionChange } from './nodeVersion'
import { startCommandChange } from './startCommand'
import { domainChange } from './domain'
import { httpsChange } from './https'
import { internalPortChange } from './internalPort'
import { depsInstallChange } from './deps'
import { normalizeLineEndingsChange } from './lineEndings'
import { restartWebChange } from './restartWeb'
import { androidBuildChange } from './androidBuild'
import { androidRunChange } from './androidRun'
import {
  dbBackupChange,
  dbRestoreChange,
  serviceAddChange,
  serviceRemoveChange,
  serviceRestartChange,
  serviceVersionChange
} from './services'
import { osSettingsChange } from './osSettings'
import { packageManagerChange } from './packageManager'
import { emulatorConfigChange } from './emulatorConfig'
import { packageInstallChange } from './packageInstall'
import { roomResetChange } from './roomReset'

export function registerQuickChanges(engine: ChangeEngine): void {
  engine.register(nodeVersionChange)
  engine.register(startCommandChange)
  engine.register(domainChange)
  engine.register(httpsChange)
  engine.register(internalPortChange)
  engine.register(depsInstallChange)
  engine.register(normalizeLineEndingsChange)
  engine.register(restartWebChange)
  engine.register(androidBuildChange)
  engine.register(androidRunChange)
  engine.register(serviceAddChange)
  engine.register(serviceRemoveChange)
  engine.register(serviceRestartChange)
  engine.register(serviceVersionChange)
  engine.register(dbBackupChange)
  engine.register(dbRestoreChange)
  engine.register(osSettingsChange)
  engine.register(packageManagerChange)
  engine.register(emulatorConfigChange)
  engine.register(packageInstallChange)
  engine.register(roomResetChange)
}

export { pmInstallCommand, currentDepsGen, depsVolumeForGen, depsGenKey, depsGenMaxKey } from './deps'
export { packageInstallCommand } from './packageInstall'
