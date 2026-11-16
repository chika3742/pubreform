// Flutter SDK updates: the release list, the target version, rewriting the files that name the version,
// planning the update with the new SDK, and its changelog.
import fs from 'node:fs/promises'
import path from 'node:path'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { isMap, isScalar, parseDocument } from 'yaml'
import type { Versioning } from './config.ts'
import { type Resolve, type Unit, solveFailure } from './planner.ts'
import { type DirectDep, withConstraints } from './pubspec.ts'
import { changelogSections, withoutBacklinks } from './render.ts'
import { allows, compareVersions, isPinned, parseVersion, splitConstraint } from './version.ts'

const TIMEOUT_MS = 30_000
const RELEASES_URL = 'https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json'
const RAW_FLUTTER = 'https://raw.githubusercontent.com/flutter/flutter'
const FLUTTER_REPO = 'https://github.com/flutter/flutter'
const STABLE = /^\d+\.\d+\.\d+$/

type Obj = Record<string, unknown>

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The stable version that `.fvmrc` pins, or undefined when it pins none (or is missing or not valid JSON). */
export function pinnedFlutter(fvmrc: string | undefined): string | undefined {
  if (fvmrc === undefined) return undefined
  try {
    const flutter = JSON.parse(fvmrc)?.flutter
    return typeof flutter === 'string' && STABLE.test(flutter) ? flutter : undefined
  } catch {
    return undefined
  }
}

// ---- Releases and the target ----

export interface FlutterRelease {
  version: string
  /** The bundled Dart. */
  dart: string
  released: Date
}

/** The stable releases in releases_linux.json. Throws when `releases` is not a list; skips entries it cannot use. */
export function parseReleases(json: unknown): FlutterRelease[] {
  if (!isObject(json) || !Array.isArray(json.releases)) throw new Error('releases is not a list')
  const result: FlutterRelease[] = []
  const seen = new Set<string>()
  for (const r of json.releases) {
    if (!isObject(r) || r.channel !== 'stable') continue
    const { version, dart_sdk_version: dart, release_date: date } = r
    if (typeof version !== 'string' || !STABLE.test(version) || typeof dart !== 'string' || !STABLE.test(dart)) continue
    const released = typeof date === 'string' ? new Date(date) : undefined
    if (released === undefined || Number.isNaN(released.getTime()) || seen.has(version)) continue
    seen.add(version)
    result.push({ version, dart, released })
  }
  return result
}

/** Fetches the release list. `url` is for tests. Throws when it cannot be fetched or read. */
export async function fetchReleases(url = RELEASES_URL): Promise<FlutterRelease[]> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return parseReleases(await res.json())
  } catch (e) {
    throw new Error(`cannot get the Flutter releases: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export interface FlutterTarget {
  from: string
  to: string
  /** The Dart bundled with `from`, when the list has it. */
  dartFrom?: string
  dartTo: string
  released: Date
}

/**
 * The newest release after `current` published by the cutoff, and the newest one after that which waits for the
 * release age.
 */
export function chooseTarget(
  releases: FlutterRelease[],
  current: string,
  cutoff: Date,
): { target?: FlutterTarget; waiting?: { version: string; released: Date } } {
  const newest = (list: FlutterRelease[]) =>
    list.reduce<FlutterRelease | undefined>((max, r) => (max === undefined || compareVersions(r.version, max.version) > 0 ? r : max), undefined)
  const candidates = releases.filter((r) => compareVersions(r.version, current) > 0)
  const t = newest(candidates.filter((r) => r.released <= cutoff))
  const w = newest(candidates.filter((r) => r.released > cutoff))
  const dartFrom = releases.find((r) => r.version === current)?.dart
  return {
    ...(t ? { target: { from: current, to: t.version, ...(dartFrom ? { dartFrom } : {}), dartTo: t.dart, released: t.released } } : {}),
    ...(w && (t === undefined || compareVersions(w.version, t.version) > 0) ? { waiting: { version: w.version, released: w.released } } : {}),
  }
}

// ---- Rewriting files ----

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `.fvmrc` with `flutter` set to `to`. Throws when anything but `flutter` would change. */
export function rewriteFvmrc(text: string, from: string, to: string): string {
  const rewritten = text.replace(new RegExp(`("flutter"\\s*:\\s*")${escapeRegExp(from)}"`), `$1${to}"`)
  const before = JSON.parse(text)
  const after = JSON.parse(rewritten)
  if (after?.flutter !== to || JSON.stringify({ ...after, flutter: from }) !== JSON.stringify(before)) {
    throw new Error(`cannot rewrite the Flutter version in .fvmrc from ${from} to ${to}`)
  }
  return rewritten
}

/**
 * `.vscode/settings.json` with the versions at the end of `dart.flutterSdkPath` replaced. Not read as JSONC:
 * the same setting in a comment is replaced too.
 */
export function rewriteVscodeSettings(text: string, from: string, to: string): string {
  const setting = new RegExp(`("dart\\.flutterSdkPath"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*?(?:/|\\\\\\\\))${escapeRegExp(from)}"`, 'g')
  return text.replace(setting, `$1${to}"`)
}

/** The next boundary of the granularity of `bound` that is above `v`. */
function raisedUpper(bound: string, v: string): string {
  const b = parseVersion(bound)
  const x = parseVersion(v)
  if (b.minor === 0 && b.patch === 0) return `${x.major + 1}.0.0`
  if (b.patch === 0) return `${x.major}.${x.minor + 1}.0`
  return `${x.major}.${x.minor}.${x.patch + 1}`
}

/** An SDK constraint rewritten for the version `v`, in the same form. Returned as it is when nothing changes. */
export function rewriteSdkConstraint(constraint: string, v: string, versioning: Versioning): string {
  const keep = (written: string) => versioning === 'lockfile-only' && allows(written, v)
  let changed = false
  const parts = splitConstraint(constraint).map(({ op, version }) => {
    const written = `${op}${version}`
    let next: string
    switch (op) {
      case '':
        next = v
        break
      case '^':
        next = keep(written) ? written : `^${v}`
        break
      case '>=':
      case '>':
        next = keep(written) ? written : `>=${v}`
        break
      case '<=':
        next = allows(written, v) ? written : `<=${v}`
        break
      case '<':
        next = allows(written, v) ? written : `<${raisedUpper(version, v)}`
        break
    }
    if (next !== written) changed = true
    return next
  })
  return changed ? parts.join(' ') : constraint
}

/**
 * pubspec.yaml with `environment.sdk` and `environment.flutter` rewritten for the new versions. Only the values
 * are replaced: quotes, comments and the rest of the file are kept.
 */
export function rewriteEnvironment(pubspec: string, v: { flutter: string; dart: string }, versioning: Versioning): string {
  const env = parseDocument(pubspec).get('environment', true)
  if (!isMap(env)) return pubspec
  const edits: { start: number; end: number; text: string }[] = []
  for (const [key, version] of [
    ['sdk', v.dart],
    ['flutter', v.flutter],
  ] as const) {
    const node = env.get(key, true)
    if (!isScalar(node) || typeof node.value !== 'string' || !node.range) continue
    if (node.type !== 'PLAIN' && node.type !== 'QUOTE_DOUBLE' && node.type !== 'QUOTE_SINGLE') continue
    let next: string
    try {
      next = rewriteSdkConstraint(node.value, version, versioning)
    } catch {
      continue
    }
    if (next === node.value) continue
    const [start, end] = node.range
    const quote = node.type === 'QUOTE_DOUBLE' ? '"' : node.type === 'QUOTE_SINGLE' ? "'" : ''
    edits.push({ start, end, text: `${quote}${next}${quote}` })
  }
  let result = pubspec
  for (const e of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, e.start) + e.text + result.slice(e.end)
  return result
}

// ---- Resolving with the new SDK ----

/** Writes the tracked files of the base to `dir`, with `.fvmrc` replaced. */
export async function prepareFlutterDir(baseDir: string, dir: string, fvmrc: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(path.dirname(dir), { recursive: true })
  const gitDir = path.join(baseDir, '.git')
  await exec.exec('git', ['--git-dir', gitDir, '--work-tree', baseDir, 'checkout-index', '--all', `--prefix=${dir}/`], {
    silent: true,
  })
  await fs.writeFile(path.join(dir, '.fvmrc'), fvmrc)
}

/** Has fvm install the version of `.fvmrc` in `dir`, by running `fvm flutter --version --machine`. */
export async function installFlutter(dir: string, version: string): Promise<void> {
  await core.group(`Install Flutter ${version}`, async () => {
    const result = await exec.getExecOutput('fvm', ['flutter', '--version', '--machine'], { cwd: dir, ignoreReturnCode: true })
    if (result.exitCode !== 0) {
      throw new Error(`fvm flutter --version --machine failed with exit code ${result.exitCode}\n${result.stderr.trimEnd()}`)
    }
    let found: unknown
    try {
      found = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')))?.frameworkVersion
    } catch {
      throw new Error(`cannot read the output of fvm flutter --version --machine: ${result.stdout.trim()}`)
    }
    if (found !== version) throw new Error(`fvm runs Flutter ${String(found)} instead of ${version}`)
  })
}

const isSolveFailure = (e: unknown) => e instanceof Error && e.message.includes('version solving failed.')

/**
 * The Flutter unit: the direct dependencies that must move out of their ranges to resolve with the new SDK.
 * `pubspec` has the rewritten environment, and `resolve` runs the new SDK's pub on the base lockfile.
 * `unresolvable` is pub's explanation when no versions of the direct dependencies resolve.
 */
export async function planFlutter(input: {
  deps: DirectDep[]
  pubspec: string
  resolve: Resolve
}): Promise<{ unit: Unit } | { unresolvable: string }> {
  const { deps, pubspec, resolve } = input
  try {
    await resolve(['get'], pubspec)
    return { unit: { kind: 'flutter', members: [], targets: {} } }
  } catch (e) {
    if (!isSolveFailure(e)) throw e
  }
  let L: Map<string, string>
  try {
    L = await resolve(['get'], withConstraints(pubspec, new Map(deps.map((d) => [d.name, `>=${d.current}`]))))
  } catch (e) {
    if (isSolveFailure(e)) return { unresolvable: solveFailure((e as Error).message) }
    throw e
  }
  const version = (d: DirectDep) => {
    const v = L.get(d.name)
    if (v === undefined) throw new Error(`${d.name} is missing from the lockfile with Flutter`)
    return v
  }
  const range = (d: DirectDep) => (isPinned(d.constraint) ? `^${d.current}` : d.constraint)
  const K = deps.filter((d) => !allows(range(d), version(d)))
  const moved = deps.filter((d) => !K.includes(d) && isPinned(d.constraint) && version(d) !== d.current)
  return {
    unit: {
      kind: 'flutter',
      members: K.map((d) => d.name).sort(),
      targets: Object.fromEntries([...K, ...moved].map((d) => [d.name, version(d)])),
    },
  }
}

// ---- Changelog ----

const minorOf = (v: string) => {
  const { major, minor } = parseVersion(v)
  return `${major}.${minor}`
}

/** The release branch whose CHANGELOG.md has the sections of the minor of `version`. */
export const releaseBranch = (version: string) => `flutter-${minorOf(version)}-candidate.0`

export const flutterChangelogUrl = (version: string) => `${FLUTTER_REPO}/blob/${releaseBranch(version)}/CHANGELOG.md`

/**
 * The sections of the stable releases in (from, to], each from the release branch of its minor, newest minor first.
 * Undefined when none can be read. `base` is for tests.
 */
export async function fetchFlutterChangelog(
  releases: FlutterRelease[],
  from: string,
  to: string,
  base = RAW_FLUTTER,
): Promise<string | undefined> {
  const inRange = (v: string) => compareVersions(v, from) > 0 && compareVersions(v, to) <= 0
  const minors = [...new Set(releases.filter((r) => inRange(r.version)).map((r) => minorOf(r.version)))].sort((a, b) =>
    compareVersions(`${b}.0`, `${a}.0`),
  )
  const parts: string[] = []
  for (const minor of minors) {
    let text: string
    try {
      const res = await fetch(`${base}/${releaseBranch(`${minor}.0`)}/CHANGELOG.md`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) continue
      text = await res.text()
    } catch {
      continue
    }
    const sections = changelogSections(text, (v) => inRange(v) && minorOf(v) === minor).map((s) =>
      // A x.y.0 section ends with the heading of the next group of minors.
      s.replace(/(?:\n+## Flutter \d+\.\d+ Changes[ \t]*)+$/, '').trimEnd(),
    )
    parts.push(...sections)
  }
  return parts.length > 0 ? withoutBacklinks(parts.join('\n\n'), FLUTTER_REPO) : undefined
}
