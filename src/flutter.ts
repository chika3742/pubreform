// Updating the Flutter version in .fvmrc: the release list, the target version, and rewriting the files.
// Every file is rewritten in place, only where the value is, to keep its format and comments.
import { isScalar, parse, parseDocument } from 'yaml'
import type { UnitResult } from './applier.ts'
import { type IgnoreRule, isIgnored } from './config.ts'
import { isFlutter } from './pubspec.ts'
import { COMPARISON, allows, compareVersions, maxVersion } from './version.ts'

const RELEASES = 'https://storage.googleapis.com/flutter_infra_release/releases'
const OS: Record<string, string> = { linux: 'linux', darwin: 'macos', win32: 'windows' }
const TIMEOUT_MS = 30_000
const VERSION = /^\d+\.\d+\.\d+$/

export const VSCODE_SETTINGS = '.vscode/settings.json'
const SDK_PATH_KEY = 'dart.flutterSdkPath'

export interface FlutterRelease {
  version: string
  /** dart_sdk_version */
  dart?: string
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The release list of the runner's OS. PUBREFORM_FLUTTER_RELEASES replaces it in tests. */
export function releasesUrl(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (env.PUBREFORM_FLUTTER_RELEASES) return env.PUBREFORM_FLUTTER_RELEASES
  const os = OS[platform]
  if (!os) throw new Error(`there is no Flutter release list for ${platform}`)
  return `${RELEASES}/releases_${os}.json`
}

/** Stable releases with an x.y.z version, the first of each version. Throws when the list has another shape. */
export function parseReleases(body: unknown): FlutterRelease[] {
  const releases = isObject(body) ? body.releases : undefined
  if (!Array.isArray(releases)) throw new Error('the Flutter release list has no releases')
  const found = new Map<string, FlutterRelease>()
  for (const r of releases) {
    if (!isObject(r) || typeof r.channel !== 'string' || typeof r.version !== 'string') {
      throw new Error(`invalid Flutter release: ${JSON.stringify(r)}`)
    }
    if (r.channel !== 'stable' || !VERSION.test(r.version) || found.has(r.version)) continue
    found.set(r.version, { version: r.version, ...(typeof r.dart_sdk_version === 'string' ? { dart: r.dart_sdk_version } : {}) })
  }
  return [...found.values()]
}

export async function fetchReleases(url: string): Promise<FlutterRelease[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`cannot get the Flutter releases from ${url}: HTTP ${res.status}`)
  return parseReleases(await res.json())
}

/** The `flutter` version in .fvmrc, or undefined when it is not a version (a channel, a commit, a fork, ...). */
export function currentFlutter(fvmrc: string): string | undefined {
  try {
    const value = JSON.parse(fvmrc)?.flutter
    return typeof value === 'string' && VERSION.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Whether `ignore` skips every Flutter update. */
export function ignoresFlutter(ignore: IgnoreRule[]): boolean {
  return ignore.some((rule) => rule.name === 'flutter' && rule.versions === undefined)
}

/** The newest release that `ignore` does not cover, when it is newer than `current`. */
export function flutterTarget(current: string, releases: FlutterRelease[], ignore: IgnoreRule[]): string | undefined {
  const target = maxVersion(releases.map((r) => r.version).filter((v) => !isIgnored(ignore, 'flutter', v)))
  return target !== undefined && compareVersions(target, current) > 0 ? target : undefined
}

export function rewriteFvmrc(text: string, from: string, to: string): string {
  const result = text.replace(new RegExp(`("flutter"\\s*:\\s*")${escapeRegExp(from)}"`), `$1${to}"`)
  const before = JSON.parse(text)
  const after = JSON.parse(result)
  // The first match must be the top-level key: everything else stays the same.
  if (after?.flutter !== to || JSON.stringify({ ...after, flutter: from }) !== JSON.stringify(before)) {
    throw new Error(`cannot rewrite "flutter" in .fvmrc from ${from} to ${to}`)
  }
  return result
}

type Token = { type: 'string' | 'punct' | 'other'; start: number; end: number }

/** Tokens of JSON with comments. Throws on an unclosed string or comment. */
function jsoncTokens(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (/\s/.test(c)) {
      i++
    } else if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) throw new Error('unclosed comment')
      i = end + 2
    } else if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      if (j >= text.length) throw new Error('unclosed string')
      tokens.push({ type: 'string', start: i, end: j + 1 })
      i = j + 1
    } else if ('{}[]:,'.includes(c)) {
      tokens.push({ type: 'punct', start: i, end: i + 1 })
      i++
    } else {
      let j = i + 1
      while (j < text.length && !/[\s{}[\]:,"/]/.test(text[j]!)) j++
      tokens.push({ type: 'other', start: i, end: j })
      i = j
    }
  }
  return tokens
}

/** The raw text range (inside the quotes) of the string value of a top-level key, or undefined. */
function jsoncStringValue(text: string, key: string): { start: number; end: number } | undefined {
  const tokens = jsoncTokens(text)
  const stack: string[] = []
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!
    const s = text.slice(t.start, t.end)
    if (t.type === 'punct') {
      if (s === '{' || s === '[') stack.push(s)
      else if (s === '}' || s === ']') stack.pop()
      continue
    }
    if (t.type !== 'string' || stack.length !== 1 || stack[0] !== '{') continue
    const colon = tokens[k + 1]
    const value = tokens[k + 2]
    if (!colon || text.slice(colon.start, colon.end) !== ':') continue
    if (JSON.parse(s) === key) {
      return value?.type === 'string' ? { start: value.start + 1, end: value.end - 1 } : undefined
    }
    k += 1
  }
  return undefined
}

/**
 * .vscode/settings.json with `c` replaced by `t` where it is a path segment of `dart.flutterSdkPath`
 * (`.fvm/versions/<c>`). Undefined when nothing changes, including when the file cannot be scanned.
 */
export function rewriteVscodeSettings(
  text: string,
  from: string,
  to: string,
  log: (message: string) => void = () => {},
): string | undefined {
  let range: { start: number; end: number } | undefined
  try {
    range = jsoncStringValue(text, SDK_PATH_KEY)
  } catch (e) {
    log(`${VSCODE_SETTINGS} is not changed: ${e instanceof Error ? e.message : String(e)}`)
    return undefined
  }
  if (!range) return undefined
  const raw = text.slice(range.start, range.end)
  // Segments are separated by / or, in a Windows path, by an escaped backslash (\\ in the JSON text).
  const segment = new RegExp(String.raw`(^|/|\\\\)${escapeRegExp(from)}(?=$|/|\\\\)`, 'g')
  const next = raw.replace(segment, `$1${to}`)
  if (next === raw) return undefined
  const result = text.slice(0, range.start) + next + text.slice(range.end)
  const check = jsoncStringValue(result, SDK_PATH_KEY)
  if (!check || result.slice(check.start, check.end) !== next) throw new Error(`cannot rewrite ${SDK_PATH_KEY} in ${VSCODE_SETTINGS}`)
  return result
}

/** The comparisons of a constraint as written, or undefined when it is not a list of comparisons. */
function comparisons(constraint: string): { op: string; version: string; text: string }[] | undefined {
  let rest = constraint.trim()
  if (rest === '') return undefined
  const result: { op: string; version: string; text: string }[] = []
  while (rest !== '') {
    const m = COMPARISON.exec(rest)
    if (!m) return undefined
    result.push({ op: m[1] ?? '', version: m[2]!, text: m[0] })
    rest = rest.slice(m[0].length).trimStart()
  }
  return result
}

/**
 * The `environment.flutter` constraint with its lower bound raised to `to`, in the same form.
 * Undefined when it stays: no lower bound, already at `to` or above, or an upper bound that excludes `to`.
 */
export function flutterConstraint(constraint: string, to: string): string | undefined {
  if (constraint.trim() === 'any') return undefined
  const parts = comparisons(constraint)
  if (!parts) return undefined
  const lower = parts.filter((p) => p.op === '^' || p.op === '>=' || p.op === '>' || p.op === '')
  if (lower.length !== 1) return undefined
  const low = lower[0]!
  if (compareVersions(low.version, to) >= 0) return undefined
  if (parts.length === 1) return low.op === '^' ? `^${to}` : low.op === '' ? to : `>=${to}`
  // ^ and exact versions are bounded already: combined with more comparisons, the form is not ours to change.
  if (low.op === '^' || low.op === '') return undefined
  const upper = parts.filter((p) => p !== low)
  // An explicit upper bound is the user's: when it excludes `to`, the constraint is left as it is.
  if (!upper.every((u) => allows(u.text, to))) return undefined
  return [`>=${to}`, ...upper.map((u) => u.text)].join(' ')
}

/** pubspec.yaml with `environment.flutter` rewritten by flutterConstraint, or the same text. */
export function rewriteEnvironmentFlutter(pubspec: string, to: string): string {
  const doc = parseDocument(pubspec)
  const node = doc.getIn(['environment', 'flutter'], true)
  if (!isScalar(node) || typeof node.value !== 'string' || !node.range) return pubspec
  const next = flutterConstraint(node.value, to)
  if (next === undefined) return pubspec
  const source =
    node.type === 'QUOTE_DOUBLE' ? JSON.stringify(next) : node.type === 'QUOTE_SINGLE' ? `'${next}'` : node.type === 'PLAIN' ? next : undefined
  if (source === undefined) return pubspec
  const result = pubspec.slice(0, node.range[0]) + source + pubspec.slice(node.range[1])
  if (parse(result)?.environment?.flutter !== next) throw new Error(`cannot rewrite environment.flutter to ${next}`)
  return result
}

/** The flutter unit: the files rewritten for `to`. pub runs only when the pull request is committed. */
export function applyFlutter(opts: {
  from: string
  to: string
  releases: FlutterRelease[]
  pubspec: string
  lock: string
  fvmrc: string
  vscodeSettings?: string
  log?: (message: string) => void
}): UnitResult {
  const { from, to } = opts
  const files: Record<string, string> = { '.fvmrc': rewriteFvmrc(opts.fvmrc, from, to) }
  if (opts.vscodeSettings !== undefined) {
    const settings = rewriteVscodeSettings(opts.vscodeSettings, from, to, opts.log)
    if (settings !== undefined) files[VSCODE_SETTINGS] = settings
  }
  const dart = (version: string) => opts.releases.find((r) => r.version === version)?.dart
  const fromDart = dart(from)
  const toDart = dart(to)
  return {
    unit: { kind: 'flutter', members: ['flutter'], targets: { flutter: to } },
    files: { pubspec: rewriteEnvironmentFlutter(opts.pubspec, to), lock: opts.lock },
    changes: {},
    transitiveFixes: {},
    advisories: [],
    flutter: {
      from,
      to,
      ...(fromDart ? { fromDart } : {}),
      ...(toDart ? { toDart } : {}),
      tool: isFlutter(opts.pubspec) ? 'flutter' : 'dart',
      files,
    },
  }
}
