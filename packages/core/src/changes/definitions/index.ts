import type { ChangeEngine } from '../engine'
import { nodeVersionChange } from './nodeVersion'
import { startCommandChange } from './startCommand'
import { domainChange } from './domain'
import { httpsChange } from './https'
import { internalPortChange } from './internalPort'
import { depsInstallChange } from './deps'
import { restartWebChange } from './restartWeb'
import { androidBuildChange } from './androidBuild'
import { dbBackupChange, dbRestoreChange, serviceAddChange, serviceRemoveChange, serviceRestartChange } from './services'
import { osSettingsChange } from './osSettings'

export function registerQuickChanges(engine: ChangeEngine): void {
  engine.register(nodeVersionChange)
  engine.register(startCommandChange)
  engine.register(domainChange)
  engine.register(httpsChange)
  engine.register(internalPortChange)
  engine.register(depsInstallChange)
  engine.register(restartWebChange)
  engine.register(androidBuildChange)
  engine.register(serviceAddChange)
  engine.register(serviceRemoveChange)
  engine.register(serviceRestartChange)
  engine.register(dbBackupChange)
  engine.register(dbRestoreChange)
  engine.register(osSettingsChange)
}

export { pmInstallCommand, currentDepsGen, depsVolumeForGen, depsGenKey } from './deps'
