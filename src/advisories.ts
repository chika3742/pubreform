// Security advisories: which locked packages need a fix, and the version that fixes them.
// pub.dev returns the advisories of the GitHub Advisory Database in the OSV format.
import type { Listing } from './proxy.ts'
import { ignoredAdvisories, isPubDev, parseLock } from './pubspec.ts'
import { compareVersions, isStable } from './version.ts'

const TIMEOUT_MS = 30_000
const CONCURRENCY = 8

export interface Advisory {
  id: string
  aliases: string[]
  summary?: string
  /** `database_specific.severity`, in lower case. */
  severity?: string
  /** `database_specific.pub_display_url`, only when it cannot leave a Markdown link. */
  url?: string
  /** Versions of this package that the advisory affects. */
  versions: Set<string>
}

export interface Fix {
  name: string
  /** c(p): the version in the base lockfile. */
  locked: string
  /** Valid advisories that affect the locked version, in id order. */
  advisories: Advisory[]
  /** Versions that any valid advisory affects. */
  affected: Set<string>
  /** f(p): the oldest version that fixes the advisories. Undefined when there is none. */
  fix?: { version: string; published?: Date }
}

type Obj = Record<string, unknown>

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** The advisories of `name` in a response of /api/packages/<name>/advisories. Throws on an unexpected shape. */
export function parseAdvisories(body: unknown, name: string): Advisory[] {
  const invalid = (what: string) => new Error(`unexpected advisories of ${name}: ${what}`)
  if (!isObject(body) || !Array.isArray(body.advisories)) throw invalid('advisories is not a list')
  const result: Advisory[] = []
  for (const entry of body.advisories) {
    if (!isObject(entry) || typeof entry.id !== 'string') throw invalid('an advisory has no id')
    if (!Array.isArray(entry.affected)) throw invalid(`${entry.id} has no affected list`)
    const versions = new Set<string>()
    let matched = false
    for (const affected of entry.affected) {
      const pkg = isObject(affected) ? affected.package : undefined
      if (!isObject(affected) || !isObject(pkg) || typeof pkg.name !== 'string' || typeof pkg.ecosystem !== 'string') {
        throw invalid(`${entry.id} has an affected package without a name or an ecosystem`)
      }
      if (!isStrings(affected.versions)) throw invalid(`${entry.id} has affected versions that are not a list of strings`)
      if (pkg.name !== name || pkg.ecosystem.toLowerCase() !== 'pub') continue
      matched = true
      for (const v of affected.versions) versions.add(v)
    }
    if ('withdrawn' in entry || !matched) continue
    const specific = isObject(entry.database_specific) ? entry.database_specific : {}
    const advisory: Advisory = { id: entry.id, aliases: isStrings(entry.aliases) ? entry.aliases : [], versions }
    if (typeof entry.summary === 'string') advisory.summary = entry.summary
    if (typeof specific.severity === 'string') advisory.severity = specific.severity.toLowerCase()
    const url = specific.pub_display_url
    // From the advisory database: anything that could leave the Markdown link is dropped.
    if (typeof url === 'string' && /^https?:\/\/[^\s()[\]<>]+$/.test(url)) advisory.url = url
    result.push(advisory)
  }
  return result
}

/** Advisories that `ignored_advisories` does not name by their id or an alias. */
export function validAdvisories(advisories: Advisory[], ignored: Set<string>): Advisory[] {
  return advisories.filter((a) => !ignored.has(a.id) && !a.aliases.some((alias) => ignored.has(alias)))
}

function stable(version: string): boolean {
  try {
    return isStable(version)
  } catch {
    return false
  }
}

/** Undefined when no valid advisory affects the locked version. */
export function findFix(name: string, locked: string, listing: Listing, advisories: Advisory[]): Fix | undefined {
  const affecting = advisories.filter((a) => a.versions.has(locked))
  if (affecting.length === 0) return undefined
  const affected = new Set(advisories.flatMap((a) => [...a.versions]))
  let fix: Fix['fix']
  for (const v of listing.versions) {
    if (!stable(v.version) || v.retracted === true || affected.has(v.version)) continue
    if (compareVersions(v.version, locked) <= 0) continue
    if (fix === undefined || compareVersions(v.version, fix.version) < 0) {
      fix = { version: v.version, ...(v.published === undefined ? {} : { published: new Date(v.published) }) }
    }
  }
  const sorted = [...affecting].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { name, locked, advisories: sorted, affected, ...(fix ? { fix } : {}) }
}

/** GET /api/packages/<name>/advisories. Throws when it cannot be fetched. */
export async function fetchAdvisories(upstream: string, name: string): Promise<unknown> {
  const res = await fetch(`${upstream}/api/packages/${name}/advisories`, {
    headers: { accept: 'application/vnd.pub.v2+json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`cannot get the advisories of ${name}: HTTP ${res.status}`)
  return res.json()
}

/**
 * The packages locked in the base that need a fix. Every failure to fetch is thrown.
 * `listing` and `advisories` fetch from pub.dev; tests pass fakes.
 */
export async function collectFixes(opts: {
  pubspec: string
  lock: string
  listing: (name: string) => Promise<Listing>
  advisories: (name: string) => Promise<unknown>
}): Promise<Map<string, Fix>> {
  const ignored = ignoredAdvisories(opts.pubspec)
  const targets = [...parseLock(opts.lock)].filter(([, p]) => p.source === 'hosted' && p.url !== undefined && isPubDev(p.url))
  const found: Fix[] = []
  let next = 0
  const worker = async () => {
    while (next < targets.length) {
      const [name, locked] = targets[next++]!
      const listing = await opts.listing(name)
      // As in pub: without advisoriesUpdated, the package has no advisories.
      if (listing.advisoriesUpdated === undefined) continue
      const advisories = validAdvisories(parseAdvisories(await opts.advisories(name), name), ignored)
      const fix = findFix(name, locked.version, listing, advisories)
      if (fix) found.push(fix)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker))
  found.sort((a, b) => (a.name < b.name ? -1 : 1))
  return new Map(found.map((f) => [f.name, f]))
}
