// Applying an update unit to the base.
import type { Advisory, Fix } from './advisories.ts'
import type { Versioning } from './config.ts'
import type { Unit } from './planner.ts'
import type { PubFiles } from './pub.ts'
import { type DirectDep, type Section, lockVersions } from './pubspec.ts'
import { isPinned } from './version.ts'

export interface Change {
  from: string
  to: string
  section: Section
}

/** The Flutter SDK update of a flutter unit. */
export interface FlutterChange {
  from: string
  to: string
  dartFrom?: string
  dartTo: string
  /** .fvmrc, and .vscode/settings.json when it changed. */
  files: { path: string; content: string }[]
  /** The extracted changelog, when it could be fetched. */
  changelog?: string
}

export interface UnitResult {
  unit: Unit
  files: PubFiles
  /** Direct dependencies whose version changed. */
  changes: Record<string, Change>
  /** Transitive dependencies moved off the versions that security advisories affect. */
  transitiveFixes: Record<string, { from: string; to: string }>
  /** Advisories that this result fixes, by package name, then id. */
  advisories: FixedAdvisory[]
  /** Set on a flutter unit. */
  flutter?: FlutterChange
}

export interface FixedAdvisory {
  package: string
  advisory: Advisory
  from: string
  to: string
  /** The release date of `to`, when it is the fixed version shown before the release age has passed. */
  early?: Date
}

export type RunPub = (args: string[], files: PubFiles) => Promise<PubFiles>

/** The pub commands to run in order, each on the files that the previous one wrote. */
export function applyArgs(unit: Unit, deps: DirectDep[], versioning: Versioning): string[][] {
  const byName = new Map(deps.map((d) => [d.name, d]))
  const specs = (names: string[]) =>
    names.map((name) => {
      const dep = byName.get(name)
      // A constraint pinned to one version stays pinned.
      const spec = `${name}:${dep && isPinned(dep.constraint) ? '' : '^'}${unit.targets[name]}`
      return dep?.section === 'dev_dependencies' ? `dev:${spec}` : spec
    })
  // A flutter unit without targets resolves the environment and the base lockfile with the new SDK again.
  if (unit.kind === 'flutter' && Object.keys(unit.targets).length === 0) return [['get']]
  if (unit.kind !== 'minor') return [['add', ...specs(Object.keys(unit.targets))]]
  const upgrade = versioning === 'increase' ? ['upgrade', '--tighten'] : ['upgrade']
  // pub upgrade does not move pinned versions, so they are raised to their versions in U first.
  const pinned = Object.keys(unit.targets)
  return pinned.length > 0 ? [['add', ...specs(pinned)], upgrade] : [upgrade]
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

/**
 * Returns undefined when neither a direct dependency nor a fixed transitive one changes, except for a flutter unit:
 * its update is the Flutter version. `flutter` is put in the result as it is.
 */
export async function applyUnit(
  unit: Unit,
  opts: {
    base: PubFiles
    deps: DirectDep[]
    versioning: Versioning
    pub: RunPub
    fixes: Map<string, Fix>
    cutoff: Date
    flutter?: FlutterChange
  },
): Promise<UnitResult | undefined> {
  let files = opts.base
  for (const args of applyArgs(unit, opts.deps, opts.versioning)) files = await opts.pub(args, files)
  const changes = directChanges(opts.deps, files.lock)
  const versions = lockVersions(files.lock)
  const transitiveFixes: UnitResult['transitiveFixes'] = {}
  const advisories: FixedAdvisory[] = []
  for (const fix of [...opts.fixes.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const to = versions.get(fix.name)
    if (to === undefined || to === fix.locked || fix.affected.has(to)) continue
    if (!(fix.name in changes)) transitiveFixes[fix.name] = { from: fix.locked, to }
    const published = fix.fix?.version === to ? fix.fix.published : undefined
    const early = published !== undefined && published > opts.cutoff ? published : undefined
    for (const advisory of fix.advisories) {
      advisories.push({ package: fix.name, advisory, from: fix.locked, to, ...(early ? { early } : {}) })
    }
  }
  const empty = Object.keys(changes).length === 0 && Object.keys(transitiveFixes).length === 0
  if (empty && unit.kind !== 'flutter') return undefined
  return { unit, files, changes, transitiveFixes, advisories, ...(opts.flutter ? { flutter: opts.flutter } : {}) }
}
