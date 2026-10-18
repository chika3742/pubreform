// Applying an update unit to the base.
import type { Versioning } from './config.ts'
import type { Unit } from './planner.ts'
import type { PubFiles } from './pub.ts'
import { type DirectDep, type Section, lockVersions } from './pubspec.ts'
import { parseVersion } from './version.ts'

export interface Change {
  from: string
  to: string
  section: Section
}

export interface UnitResult {
  unit: Unit
  files: PubFiles
  /** Direct dependencies whose version changed. */
  changes: Record<string, Change>
}

export type RunPub = (args: string[], files: PubFiles) => Promise<PubFiles>

export function applyArgs(unit: Unit, deps: DirectDep[], versioning: Versioning): string[] {
  if (unit.kind === 'minor') return versioning === 'increase' ? ['upgrade', '--tighten'] : ['upgrade']
  const byName = new Map(deps.map((d) => [d.name, d]))
  const specs = unit.members.map((name) => {
    const dep = byName.get(name)
    // A constraint pinned to one version stays pinned.
    const spec = `${name}:${dep && isVersion(dep.constraint) ? '' : '^'}${unit.targets[name]}`
    return dep?.section === 'dev_dependencies' ? `dev:${spec}` : spec
  })
  return ['add', ...specs]
}

function isVersion(constraint: string): boolean {
  try {
    parseVersion(constraint.trim())
    return true
  } catch {
    return false
  }
}

/** Direct dependencies whose version differs between the base lockfile and `lock`. */
export function directChanges(deps: DirectDep[], lock: string): Record<string, Change> {
  const versions = lockVersions(lock)
  const changes: Record<string, Change> = {}
  for (const d of [...deps].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const to = versions.get(d.name)
    if (to !== undefined && to !== d.current) changes[d.name] = { from: d.current, to, section: d.section }
  }
  return changes
}

/** Returns undefined when no direct dependency changes. */
export async function applyUnit(
  unit: Unit,
  opts: { base: PubFiles; deps: DirectDep[]; versioning: Versioning; pub: RunPub },
): Promise<UnitResult | undefined> {
  const files = await opts.pub(applyArgs(unit, opts.deps, opts.versioning), opts.base)
  const changes = directChanges(opts.deps, files.lock)
  if (Object.keys(changes).length === 0) return undefined
  return { unit, files, changes }
}
