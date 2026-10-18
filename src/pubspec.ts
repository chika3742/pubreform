// pubspec.yaml and pubspec.lock: reading, and rewriting the working copy.
import { createHash } from 'node:crypto'
import { isMap, isScalar, parse, parseDocument } from 'yaml'

export const PUB_DEV = 'https://pub.dev'

export type Section = 'dependencies' | 'dev_dependencies'
export const SECTIONS: Section[] = ['dependencies', 'dev_dependencies']

export interface DirectDep {
  name: string
  section: Section
  /** The original constraint. `null` is `any`. */
  constraint: string
  /** c(d): the version in the base lockfile. */
  current: string
}

export interface LockedPackage {
  version: string
  source: string
  /** `description.url` for hosted packages. */
  url?: string
}

type Obj = Record<string, unknown>

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parsePubspec(text: string): Obj {
  const doc = parse(text)
  if (!isObject(doc)) throw new Error('pubspec.yaml is not a map')
  return doc
}

export function parseLock(text: string): Map<string, LockedPackage> {
  const doc = parse(text)
  const packages = isObject(doc) && isObject(doc.packages) ? doc.packages : {}
  const result = new Map<string, LockedPackage>()
  for (const [name, entry] of Object.entries(packages)) {
    if (!isObject(entry) || typeof entry.version !== 'string') continue
    const description = entry.description
    result.set(name, {
      version: entry.version,
      source: String(entry.source),
      url: isObject(description) && typeof description.url === 'string' ? description.url : undefined,
    })
  }
  return result
}

/** name -> version for every package in the lockfile. */
export function lockVersions(text: string): Map<string, string> {
  return new Map([...parseLock(text)].map(([name, p]) => [name, p.version]))
}

function isPubDev(url: string): boolean {
  return url.replace(/\/+$/, '') === PUB_DEV
}

/** The constraint of a dependency hosted on pub.dev, or undefined for other sources. */
function hostedConstraint(value: unknown): string | undefined {
  if (value === null) return 'any'
  if (typeof value === 'string') return value
  if (!isObject(value)) return undefined
  if (Object.keys(value).some((k) => k !== 'version' && k !== 'hosted')) return undefined
  const hosted = value.hosted
  if (hosted !== undefined) {
    const url = typeof hosted === 'string' ? hosted : isObject(hosted) ? hosted.url : undefined
    if (typeof url !== 'string' || !isPubDev(url)) return undefined
  }
  if (value.version === undefined || value.version === null) return 'any'
  return typeof value.version === 'string' ? value.version : undefined
}

/** Direct dependencies that pubreform updates. */
export function directDeps(pubspecText: string, lockText: string): DirectDep[] {
  const pubspec = parsePubspec(pubspecText)
  const lock = parseLock(lockText)
  const overrides = isObject(pubspec.dependency_overrides) ? pubspec.dependency_overrides : {}
  const deps: DirectDep[] = []
  for (const section of SECTIONS) {
    const entries = pubspec[section]
    if (!isObject(entries)) continue
    for (const [name, value] of Object.entries(entries)) {
      const constraint = hostedConstraint(value)
      if (constraint === undefined || name in overrides) continue
      const locked = lock.get(name)
      if (!locked || locked.source !== 'hosted' || !locked.url || !isPubDev(locked.url)) continue
      deps.push({ name, section, constraint, current: locked.version })
    }
  }
  return deps
}

/** Whether the project depends on the Flutter SDK (`sdk: flutter`). */
export function isFlutter(pubspecText: string): boolean {
  const pubspec = parsePubspec(pubspecText)
  return SECTIONS.some((section) => {
    const entries = pubspec[section]
    return isObject(entries) && Object.values(entries).some((v) => isObject(v) && v.sdk === 'flutter')
  })
}

export function hasWorkspace(pubspecText: string): boolean {
  return 'workspace' in parsePubspec(pubspecText)
}

/** Replaces the constraints of the given dependencies. The result is not committed, so formatting is not kept. */
export function withConstraints(pubspecText: string, constraints: Map<string, string>): string {
  const doc = parseDocument(pubspecText)
  const done = new Set<string>()
  for (const section of SECTIONS) {
    const entries = doc.get(section, true)
    if (!isMap(entries)) continue
    for (const pair of entries.items) {
      const name = isScalar(pair.key) ? String(pair.key.value) : undefined
      if (name === undefined || !constraints.has(name)) continue
      const constraint = constraints.get(name)!
      if (isMap(pair.value)) {
        pair.value.set('version', constraint)
      } else {
        pair.value = doc.createNode(constraint)
      }
      done.add(name)
    }
  }
  for (const name of constraints.keys()) {
    if (!done.has(name)) throw new Error(`${name} is not a dependency in pubspec.yaml`)
  }
  return doc.toString()
}

/** SHA-256 of pubspec.yaml, pubspec.lock and .fvmrc. */
export function baseHash(files: { pubspec: string; lock: string; fvmrc?: string }): string {
  return createHash('sha256')
    .update(['pubspec.yaml', files.pubspec, 'pubspec.lock', files.lock, '.fvmrc', files.fvmrc ?? ''].join('\0'))
    .digest('hex')
}
