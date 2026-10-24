// pubspec.yaml and pubspec.lock: reading, and rewriting constraints.
import { createHash } from 'node:crypto'
import { isMap, isScalar, parse, parseDocument, stringify } from 'yaml'

export const PUB_DEV = 'https://pub.dev'

export type Section = 'dependencies' | 'dev_dependencies'
export const SECTIONS: Section[] = ['dependencies', 'dev_dependencies']

/** pubspec.yaml files by path from the root: the root's, and those of the workspace members. */
export type Pubspecs = Record<string, string>

export const ROOT_PUBSPEC = 'pubspec.yaml'

export interface Declaration {
  /** The pubspec.yaml that declares the dependency. */
  path: string
  section: Section
  /** The original constraint. `null` is `any`. */
  constraint: string
}

export interface DirectDep {
  name: string
  /** `dependencies` when any declaration is there. */
  section: Section
  declarations: Declaration[]
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

export function isPubDev(url: string): boolean {
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
export function directDeps(pubspecs: Pubspecs, lockText: string): DirectDep[] {
  const lock = parseLock(lockText)
  const parsed = Object.entries(pubspecs).map(([path, text]) => [path, parsePubspec(text)] as const)
  // pub uses the overrides of every workspace member.
  const overridden = new Set(parsed.flatMap(([, p]) => (isObject(p.dependency_overrides) ? Object.keys(p.dependency_overrides) : [])))
  const declarations = new Map<string, (Declaration | undefined)[]>()
  for (const [path, pubspec] of parsed) {
    for (const section of SECTIONS) {
      const entries = pubspec[section]
      if (!isObject(entries)) continue
      for (const [name, value] of Object.entries(entries)) {
        const constraint = hostedConstraint(value)
        const list = declarations.get(name) ?? []
        list.push(constraint === undefined ? undefined : { path, section, constraint })
        declarations.set(name, list)
      }
    }
  }
  const deps: DirectDep[] = []
  for (const [name, list] of declarations) {
    if (overridden.has(name) || list.some((d) => d === undefined)) continue
    const locked = lock.get(name)
    if (!locked || locked.source !== 'hosted' || !locked.url || !isPubDev(locked.url)) continue
    const decls = list as Declaration[]
    const section = decls.some((d) => d.section === 'dependencies') ? 'dependencies' : 'dev_dependencies'
    deps.push({ name, section, declarations: decls, current: locked.version })
  }
  return deps
}

/** Whether any of the packages depends on the Flutter SDK (`sdk: flutter`). */
export function isFlutter(pubspecs: Pubspecs): boolean {
  return Object.values(pubspecs).some((text) => {
    const pubspec = parsePubspec(text)
    return SECTIONS.some((section) => {
      const entries = pubspec[section]
      return isObject(entries) && Object.values(entries).some((v) => isObject(v) && v.sdk === 'flutter')
    })
  })
}

/** IDs in the top-level `ignored_advisories`. Empty unless it is a list of strings. */
export function ignoredAdvisories(pubspecText: string): Set<string> {
  const ignored = parsePubspec(pubspecText).ignored_advisories
  return Array.isArray(ignored) && ignored.every((id) => typeof id === 'string') ? new Set(ignored) : new Set()
}

export function hasWorkspace(pubspecText: string): boolean {
  return 'workspace' in parsePubspec(pubspecText)
}

/**
 * Gives every declaration of the given dependencies the constraint that the function returns for its original one.
 * Only the values are replaced in the text, so that comments and formatting stay.
 */
export function withConstraints(pubspecs: Pubspecs, constraints: Map<string, (old: string) => string>): Pubspecs {
  const done = new Set<string>()
  const result: Pubspecs = {}
  for (const [path, text] of Object.entries(pubspecs)) {
    result[path] = editValues(text, (name, value) => {
      const constraint = constraints.get(name)
      if (constraint === undefined) return undefined
      const old = hostedConstraint(value)
      if (old === undefined) throw new Error(`${name} in ${path} is not hosted on pub.dev`)
      done.add(name)
      return stringify(constraint(old)).trimEnd()
    })
  }
  for (const name of constraints.keys()) {
    if (!done.has(name)) throw new Error(`${name} is not a dependency in any pubspec.yaml`)
  }
  return result
}

/** Puts back the original values of the given dependencies, as written in `original`. */
export function restoreValues(pubspecs: Pubspecs, original: Pubspecs, names: Set<string>): Pubspecs {
  const result: Pubspecs = {}
  for (const [path, text] of Object.entries(pubspecs)) {
    const before = new Map<string, string>()
    if (original[path] !== undefined) editValues(original[path], (name, _, source) => void before.set(name, source))
    result[path] = editValues(text, (name, _, source) =>
      names.has(name) && before.has(name) && before.get(name) !== source ? before.get(name) : undefined,
    )
  }
  return result
}

/**
 * Replaces the versions of dependencies in `text`. `edit` gets the name, the parsed value and the source of the
 * version (empty when there is none), and returns the new source of the version, or undefined to keep it.
 */
function editValues(text: string, edit: (name: string, value: unknown, source: string) => string | undefined): string {
  const doc = parseDocument(text)
  const edits: { start: number; end: number; text: string }[] = []
  const docEdits: (() => void)[] = []
  let rewrite = false
  for (const section of SECTIONS) {
    const entries = doc.get(section, true)
    if (!isMap(entries)) continue
    for (const pair of entries.items) {
      const name = isScalar(pair.key) ? String(pair.key.value) : undefined
      if (name === undefined) continue
      const value = pair.value as { toJSON?: () => unknown } | null
      const node = isMap(pair.value) ? pair.value.get('version', true) : pair.value
      const range = isScalar(node) ? node.range : undefined
      const replacement = edit(name, value?.toJSON?.() ?? null, range ? text.slice(range[0], range[1]) : '')
      if (replacement === undefined) continue
      const parsed = parse(replacement) as unknown
      if (isMap(pair.value)) {
        const map = pair.value
        docEdits.push(() => map.set('version', parsed))
      } else {
        docEdits.push(() => (pair.value = doc.createNode(parsed)))
      }
      if (!range) {
        // shortcut: a map without `version` is written again as a whole, which loses its formatting; it is rare.
        rewrite = true
      } else if (range[0] === range[1]) {
        // A key with no value (`a:`).
        edits.push({ start: range[0], end: range[1], text: ` ${replacement}` })
      } else {
        edits.push({ start: range[0], end: range[1], text: replacement })
      }
    }
  }
  if (rewrite) {
    for (const e of docEdits) e()
    return doc.toString()
  }
  let result = text
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    // An empty replacement leaves no space after the colon.
    const start = e.text === '' ? result.slice(0, e.start).trimEnd().length : e.start
    result = result.slice(0, start) + e.text + result.slice(e.end)
  }
  return result
}

/** SHA-256 of the pubspec.yaml files, pubspec.lock and .fvmrc. */
export function baseHash(files: { pubspecs: Pubspecs; lock: string; fvmrc?: string }): string {
  const pubspecs = Object.keys(files.pubspecs)
    .sort()
    .flatMap((p) => [p, files.pubspecs[p]!])
  return createHash('sha256')
    .update([...pubspecs, 'pubspec.lock', files.lock, '.fvmrc', files.fvmrc ?? ''].join('\0'))
    .digest('hex')
}
