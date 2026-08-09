import type { ChangeEngine } from '../engine'
import { nodeVersionChange } from './nodeVersion'
import { startCommandChange } from './startCommand'
import { domainChange } from './domain'
import { httpsChange } from './https'
import { internalPortChange } from './internalPort'
import { depsInstallChange } from './deps'
import { restartWebChange } from './restartWeb'

export function registerQuickChanges(engine: ChangeEngine): void {
  engine.register(nodeVersionChange)
  engine.register(startCommandChange)
  engine.register(domainChange)
  engine.register(httpsChange)
  engine.register(internalPortChange)
  engine.register(depsInstallChange)
  engine.register(restartWebChange)
}

export { pmInstallCommand, currentDepsGen, depsVolumeForGen, depsGenKey } from './deps'
