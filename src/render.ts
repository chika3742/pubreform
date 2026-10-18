// Titles, bodies, commit messages, comments and metadata.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import type { Change, UnitResult } from './applier.ts'
import type { Unit, UnitKind } from './planner.ts'
import { compareVersions, parseVersion } from './version.ts'

export const BRANCH_PREFIX = 'pubreform/'

export interface Meta {
  v: 1
  kind: UnitKind
  packages: Record<string, [from: string, to: string]>
  baseHash: string
  configHash: string
  commit: string
  /** The branch head just before the regeneration. */
  previous?: string
  /** Set when pubreform closed the pull request. */
  closed?: true
}

// ---- Branch names, titles, commit messages ----

export function branchName(unit: Unit): string {
  switch (unit.kind) {
    case 'single':
      return `${BRANCH_PREFIX}single/${unit.members[0]}`
    case 'minor':
      return `${BRANCH_PREFIX}minor-and-patch`
    case 'group':
      return `${BRANCH_PREFIX}group/${[...unit.members].sort()[0]}`
  }
}

export function title(result: UnitResult): string {
  const { kind, members, targets } = result.unit
  const names = Object.keys(result.changes)
  const to = (name: string) => result.changes[name]?.to ?? targets[name]
  // single, and minor / group with one change, name the package.
  const name = kind === 'single' ? members[0]! : names.length === 1 ? names[0] : undefined
  if (name !== undefined) return `Update ${name} from ${result.changes[name]?.from ?? '?'} to ${to(name)}`
  if (kind === 'minor') return `Update minor and patch (${names.length} packages)`
  return `Update ${[...members].sort().map((n) => `${n} to ${to(n)}`).join(', ')}`
}

const typeOf = (change: Change) => (change.section === 'dev_dependencies' ? 'dev' : 'direct')

function sortedChanges(changes: Record<string, Change>): [string, Change][] {
  return Object.entries(changes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

function changeTable(changes: Record<string, Change>, link: boolean): string {
  const rows = sortedChanges(changes).map(([name, c]) => {
    const label = link ? `[${name}](https://pub.dev/packages/${name})` : name
    return `| ${label} | ${c.from} | ${c.to} | ${typeOf(c)} |`
  })
  return ['| Package | From | To | Type |', '|---|---|---|---|', ...rows].join('\n')
}

export function commitMessage(result: UnitResult): string {
  if (result.unit.kind === 'single' || Object.keys(result.changes).length === 1) return title(result)
  return `${title(result)}\n\n${changeTable(result.changes, false)}\n`
}

// ---- Package information from the pub cache ----

export interface PackageInfo {
  /** `repository`, or `homepage`, of the new version. */
  source?: string
  changelog?: string
}

/** Reads pubspec.yaml and CHANGELOG.md of an extracted package. Missing files are left out. */
export function readPackageInfo(dir: string): PackageInfo {
  const info: PackageInfo = {}
  try {
    const pubspec = parse(fs.readFileSync(path.join(dir, 'pubspec.yaml'), 'utf8'))
    const source = pubspec?.repository ?? pubspec?.homepage
    if (typeof source === 'string' && /^https?:\/\//.test(source)) info.source = source
  } catch {}
  try {
    info.changelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8')
  } catch {}
  return info
}

const HEADING = /^#{1,4}\s*\[?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)\]?/

/** The sections of versions in (from, to], in file order. Undefined when there are none. */
export function extractChangelog(text: string, from: string, to: string): string | undefined {
  const sections: string[] = []
  let current: string[] | undefined
  for (const line of text.split(/\r?\n/)) {
    const m = HEADING.exec(line)
    if (m) {
      let inRange = false
      try {
        const v = parseVersion(m[1]!)
        inRange = compareVersions(v, from) > 0 && compareVersions(v, to) <= 0
      } catch {}
      if (current) sections.push(current.join('\n').trimEnd())
      current = inRange ? [line] : undefined
    } else if (current) {
      current.push(line)
    }
  }
  if (current) sections.push(current.join('\n').trimEnd())
  return sections.length > 0 ? sections.join('\n\n') : undefined
}

// ---- Body ----

const CHANGELOG_BUDGET = 50_000
const BODY_LIMIT = 65_000

const REBASE_MARKER = '<!-- pubreform:rebase -->'
export const REBASE_LINE = `- [ ] Rebase this PR ${REBASE_MARKER}`

/**
 * Whether the box is checked. Only the last line with the marker is pubreform's: changelogs and source URLs
 * come before it and are written by package authors, who could add a checked copy of the line.
 */
export function isRebaseChecked(body: string): boolean {
  const line = body.split('\n').findLast((l) => l.includes(REBASE_MARKER))
  return line !== undefined && /^- \[[xX]\] /.test(line)
}

const changelogUrl = (name: string) => `https://pub.dev/packages/${name}/changelog`

function truncate(text: string, budget: number, name: string): string {
  if (text.length <= budget) return text
  const lines: string[] = []
  let length = 0
  for (const line of text.split('\n')) {
    if (length + line.length + 1 > budget) break
    lines.push(line)
    length += line.length + 1
  }
  return `${lines.join('\n')}\n…\n\n[Full changelog](${changelogUrl(name)})`
}

function packageSection(name: string, change: Change, info: PackageInfo, changelog: string | undefined): string {
  const links = [`[pub.dev](https://pub.dev/packages/${name}/versions/${change.to})`]
  if (info.source) links.push(`[Source](${info.source})`)
  const parts = [`### ${name} ${change.from} → ${change.to}`, links.join(' · ')]
  if (changelog === undefined) {
    parts.push(`[Changelog](${changelogUrl(name)})`)
  } else {
    parts.push(`<details>\n<summary>Changelog</summary>\n\n${changelog}\n\n</details>`)
  }
  return parts.join('\n\n')
}

export function renderMeta(meta: Meta): string {
  return `<!-- pubreform:meta ${JSON.stringify(meta)} -->`
}

const META = /<!-- pubreform:meta (.+?) -->/g

/** The metadata in the body, or undefined when it is missing or invalid. */
export function parseMeta(body: string): Meta | undefined {
  // The metadata is at the end of the body, so use the last match.
  const last = [...body.matchAll(META)].pop()
  if (!last) return undefined
  try {
    const meta = JSON.parse(last[1]!)
    if (meta?.v !== 1 || typeof meta.packages !== 'object' || meta.packages === null) return undefined
    return meta as Meta
  } catch {
    return undefined
  }
}

/** The body with `closed: true` in its metadata. A body without metadata is returned as is. */
export function markClosed(body: string): string {
  const last = [...body.matchAll(META)].pop()
  const meta = parseMeta(body)
  if (!last || !meta) return body
  const index = last.index!
  return body.slice(0, index) + renderMeta({ ...meta, closed: true }) + body.slice(index + last[0].length)
}

export function metaOf(
  result: UnitResult,
  hashes: { baseHash: string; configHash: string },
  commit: string,
  previous?: string,
): Meta {
  const meta: Meta = {
    v: 1,
    kind: result.unit.kind,
    packages: Object.fromEntries(sortedChanges(result.changes).map(([name, c]) => [name, [c.from, c.to]])),
    baseHash: hashes.baseHash,
    configHash: hashes.configHash,
    commit,
  }
  if (previous !== undefined) meta.previous = previous
  return meta
}

export function renderBody(result: UnitResult, meta: Meta, infos: Map<string, PackageInfo>): string {
  const changes = sortedChanges(result.changes)
  const build = (withChangelog: boolean) => {
    const budget = Math.floor(CHANGELOG_BUDGET / changes.length)
    const sections = changes.map(([name, change]) => {
      const info = infos.get(name) ?? {}
      let changelog: string | undefined
      if (withChangelog && info.changelog !== undefined) {
        const extracted = extractChangelog(info.changelog, change.from, change.to)
        if (extracted !== undefined) changelog = truncate(extracted, budget, name)
      }
      return packageSection(name, change, info, changelog)
    })
    return [
      'Updates the following packages.',
      changeTable(result.changes, true),
      ...sections,
      '---',
      REBASE_LINE,
      renderMeta(meta),
    ].join('\n\n') + '\n'
  }
  const body = build(true)
  return body.length > BODY_LIMIT ? build(false) : body
}

// ---- Comments ----

export function contentChangedComment(before: Meta['packages'], after: Record<string, Change>): string {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  const rows: string[] = []
  for (const name of names) {
    const b = before[name]
    const a = after[name]
    if (b && a && b[1] === a.to) continue
    const cell = (from: string | undefined, to: string | undefined) => (from && to ? `${from} → ${to}` : '–')
    rows.push(`| ${name} | ${cell(b?.[0], b?.[1])} | ${cell(a?.from, a?.to)} |`)
  }
  return ['The update in this PR has changed.', '', '| Package | Before | After |', '|---|---|---|', ...rows].join('\n')
}

export function closeComment(supersededBy?: number): string {
  return supersededBy === undefined ? 'Closing: this update is no longer needed.' : `Closing: superseded by #${supersededBy}.`
}

export function manualMarker(headSha: string): string {
  return `<!-- pubreform:manual ${headSha} -->`
}

export function manualComment(headSha: string): string {
  return (
    'This PR has commits that pubreform did not create, so pubreform will not update it automatically. ' +
    'Check "Rebase this PR" to discard those commits and regenerate it.\n' +
    manualMarker(headSha)
  )
}

export function errorHash(log: string): string {
  return createHash('sha256').update(log).digest('hex').slice(0, 12)
}

const ERROR_MARKER = /<!-- pubreform:error ([0-9a-f]+) -->/

/** The hash in an error comment, or undefined when it is not one. */
export function errorHashOf(comment: string): string | undefined {
  return ERROR_MARKER.exec(comment)?.[1]
}

export function errorComment(log: string): string {
  // A fence longer than any backtick run in the log.
  const longest = Math.max(0, ...[...log.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return [
    'pubreform failed to update this PR.',
    '',
    '<details>',
    '<summary>Log</summary>',
    '',
    fence,
    log,
    fence,
    '',
    '</details>',
    `<!-- pubreform:error ${errorHash(log)} -->`,
  ].join('\n')
}

// ---- Logs ----

const MAX_LOG_LINES = 200
const MAX_LOG_CHARS = 60_000

/** Keeps the end of the log and masks the token and credentials in URLs. */
export function formatLog(log: string, secrets: string[]): string {
  let text = log.split('\n').slice(-MAX_LOG_LINES).join('\n')
  if (text.length > MAX_LOG_CHARS) text = text.slice(-MAX_LOG_CHARS)
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '***')
  return text.replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, '://***@')
}
