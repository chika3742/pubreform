// Matching planned units with existing pull requests and deciding operations.
import type { UnitResult } from './applier.ts'
import { PostUpdateError, type TreeEntry } from './generate.ts'
import type { Plan, Unit } from './planner.ts'
import type { GitHub } from './github.ts'
import {
  BRANCH_PREFIX,
  type Meta,
  type PackageInfo,
  branchName,
  closeComment,
  commitMessage,
  contentChangedComment,
  errorComment,
  errorHash,
  errorHashOf,
  isRebaseChecked,
  manualComment,
  manualMarker,
  markClosed,
  metaOf,
  renderBody,
  title,
} from './render.ts'

export interface PrState {
  number: number
  branch: string
  headSha: string
  title: string
  body: string
  meta?: Meta
  mergeable?: boolean | null
  mergeableState?: string
}

export interface UnitError {
  unit: Unit
  log: string
}

export type Op =
  | { op: 'create'; result: UnitResult; branch: string }
  | { op: 'regenerate'; pr: PrState; result: UnitResult; contentChanged: boolean }
  | { op: 'notifyManual'; pr: PrState }
  | { op: 'commentError'; pr: PrState; log: string }
  | { op: 'close'; pr: PrState; supersededBy?: string } // supersededBy: the branch of the unit that takes over
  | { op: 'none'; pr: PrState }
  /** A unit without a pull request, skipped because the same update was closed without merging. */
  | { op: 'skip'; result: UnitResult; closedPr: PrState }
  /** A unit that failed to apply and has no pull request. Only logged. */
  | { op: 'error'; unit: Unit; log: string }

export interface DecideContext {
  baseHash: string
  configHash: string
}

type Item = { unit: Unit; result?: UnitResult; error?: string }

const GROUP_PREFIX = `${BRANCH_PREFIX}group/`

/** Package names in the pull request, from the metadata or the branch name. */
function prPackages(pr: PrState): string[] {
  if (pr.meta) return Object.keys(pr.meta.packages)
  const m = /^pubreform\/(?:single|group)\/(.+)$/.exec(pr.branch)
  return m ? [m[1]!] : []
}

function targets(result: UnitResult): Map<string, string> {
  return new Map(Object.entries(result.changes).map(([name, c]) => [name, c.to]))
}

function sameTargets(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && [...a].every(([name, to]) => b.get(name) === to)
}

function metaTargets(meta: Meta): Map<string, string> {
  return new Map(Object.entries(meta.packages).map(([name, [, to]]) => [name, to]))
}

/** Pairs units with open pull requests. */
export function match(items: Item[], openPrs: PrState[]): Map<Item, PrState> {
  const pairs = new Map<Item, PrState>()
  const used = new Set<PrState>()
  const take = (item: Item, pr: PrState) => {
    pairs.set(item, pr)
    used.add(pr)
  }

  // single and minor: by branch name.
  for (const item of items.filter((i) => i.unit.kind !== 'group')) {
    const pr = openPrs.find((p) => !used.has(p) && p.branch === branchName(item.unit))
    if (pr) take(item, pr)
  }

  // group: by overlap of packages, greedily from the largest overlap, then the smaller PR number.
  const groups = items.filter((i) => i.unit.kind === 'group')
  const groupPrs = openPrs.filter((p) => p.branch.startsWith(GROUP_PREFIX))
  const candidates: { item: Item; pr: PrState; overlap: number }[] = []
  for (const item of groups) {
    for (const pr of groupPrs.filter((p) => p.meta)) {
      const overlap = Object.keys(pr.meta!.packages).filter((name) => item.unit.members.includes(name)).length
      if (overlap > 0) candidates.push({ item, pr, overlap })
    }
  }
  candidates.sort((a, b) => b.overlap - a.overlap || a.pr.number - b.pr.number)
  for (const { item, pr } of candidates) {
    if (!pairs.has(item) && !used.has(pr)) take(item, pr)
  }
  // group PRs without metadata: the first package in the branch name must be a member.
  for (const pr of groupPrs.filter((p) => !p.meta && !used.has(p))) {
    const first = pr.branch.slice(GROUP_PREFIX.length)
    const item = groups.find((i) => !pairs.has(i) && i.unit.members.includes(first))
    if (item) take(item, pr)
  }
  return pairs
}

function decideBoth(pr: PrState, result: UnitResult, ctx: DecideContext): Op {
  const checked = isRebaseChecked(pr.body)
  const meta = pr.meta
  const contentChanged = meta !== undefined && !sameTargets(metaTargets(meta), targets(result))
  const regenerate: Op = { op: 'regenerate', pr, result, contentChanged }
  if (meta && pr.headSha !== meta.commit && pr.headSha !== meta.previous && !checked) return { op: 'notifyManual', pr }
  // The previous regeneration stopped before moving the branch.
  if (meta && meta.previous !== undefined && pr.headSha === meta.previous) return regenerate
  if (checked) return regenerate
  if (pr.mergeable === false && pr.mergeableState === 'dirty') return regenerate
  if (contentChanged) return regenerate
  if (meta && (meta.baseHash !== ctx.baseHash || meta.configHash !== ctx.configHash)) return regenerate
  if (!meta) return regenerate
  return { op: 'none', pr }
}

/**
 * Decides the operations. Pure: comments are not read here.
 * `results` are the applied units, `unitErrors` the units that failed to apply.
 */
export function decide(
  results: UnitResult[],
  unitErrors: UnitError[],
  plan: Pick<Plan, 'uncertain'>,
  openPrs: PrState[],
  closedPrs: PrState[],
  ctx: DecideContext,
): Op[] {
  const items: Item[] = [
    ...results.map((result) => ({ unit: result.unit, result })),
    ...unitErrors.map((e) => ({ unit: e.unit, error: e.log })),
  ]
  const pairs = match(items, openPrs)
  const ops: Op[] = []

  for (const item of items) {
    const pr = pairs.get(item)
    if (item.error !== undefined) {
      ops.push(pr ? { op: 'commentError', pr, log: item.error } : { op: 'error', unit: item.unit, log: item.error })
      continue
    }
    const result = item.result!
    if (pr) {
      ops.push(decideBoth(pr, result, ctx))
      continue
    }
    const closed = closedPrs.find(
      // Only pull requests that a person closed stop the same update; those closed by pubreform do not.
      (p) =>
        p.meta &&
        !p.meta.closed &&
        p.meta.kind === result.unit.kind &&
        sameTargets(metaTargets(p.meta), targets(result)),
    )
    ops.push(closed ? { op: 'skip', result, closedPr: closed } : { op: 'create', result, branch: branchName(result.unit) })
  }

  const matched = new Set(pairs.values())
  // Packages of units that failed to apply: their pull requests are kept, as for uncertain ones.
  const failed = new Set(unitErrors.flatMap((e) => e.unit.members))
  for (const pr of openPrs.filter((p) => !matched.has(p))) {
    const packages = prPackages(pr)
    if (packages.some((name) => plan.uncertain.has(name) || failed.has(name))) {
      ops.push({ op: 'none', pr })
      continue
    }
    const successor = items.find((i) => {
      const names = new Set([...i.unit.members, ...Object.keys(i.result?.changes ?? {})])
      return packages.some((name) => names.has(name))
    })
    const supersededBy = successor ? (pairs.get(successor)?.branch ?? branchName(successor.unit)) : undefined
    ops.push({ op: 'close', pr, supersededBy })
  }
  return ops
}

// ---- Execution ----

export interface Outcome {
  kind: Unit['kind'] | undefined
  packages: string[]
  action: 'created' | 'regenerated' | 'unchanged' | 'closed' | 'skipped' | 'notified' | 'error'
  pr?: number
  error?: string
}

export interface ExecuteContext {
  github: Pick<
    GitHub,
    | 'createCommit'
    | 'createBranch'
    | 'updateBranch'
    | 'deleteBranch'
    | 'createPr'
    | 'updatePr'
    | 'closePr'
    | 'ensureLabels'
    | 'addLabels'
    | 'comments'
    | 'comment'
  >
  base: string
  baseSha: string
  baseTree: string
  hashes: DecideContext
  labels: string[]
  packageInfo: (name: string, version: string) => PackageInfo
  /** Formats an error log for a comment or the job log. */
  formatLog: (log: string) => string
  /** Logs an error. */
  log: (message: string) => void
  /** Logs an operation on a pull request. */
  info: (message: string) => void
  /** Runs the post_update commands on a unit to be committed, and returns the files that they changed. */
  generate?: (result: UnitResult) => Promise<TreeEntry[]>
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function unitPackages(result: UnitResult): string[] {
  return Object.keys(result.changes)
}

function prKind(pr: PrState): Unit['kind'] | undefined {
  return pr.meta?.kind
}

/** Runs the operations. Failures are returned as outcomes with `error`, never thrown. */
export async function execute(ops: Op[], ctx: ExecuteContext): Promise<Outcome[]> {
  const { github } = ctx
  const outcomes: Outcome[] = []
  /** branch -> pull request number, for "superseded by". */
  const numbers = new Map<string, number>()

  const labels = async () =>
    ctx.labels.length === 0
      ? []
      : github.ensureLabels(ctx.labels, (label, e) => {
          outcomes.push({ kind: undefined, packages: [], action: 'error', error: `cannot create label "${label}": ${errorText(e)}` })
        })

  /** `key` identifies the error for the duplicate check instead of the log. */
  const commentError = async (pr: number, rawLog: string, key?: string) => {
    const log = ctx.formatLog(rawLog)
    const hash = errorHash(key ?? log)
    const comments = await github.comments(pr)
    const last = comments.filter((c) => c.isBot && errorHashOf(c.body) !== undefined).pop()
    if (last && errorHashOf(last.body) === hash) return
    await github.comment(pr, errorComment(log, hash))
  }

  /** Records a failure, and comments it on the pull request if there is one. */
  const fail = async (outcome: Omit<Outcome, 'action' | 'error'>, e: unknown) => {
    const error = errorText(e)
    ctx.log(`Error (${outcome.packages.join(', ')}): ${ctx.formatLog(error)}`)
    let comment = ''
    if (outcome.pr !== undefined) {
      try {
        await commentError(outcome.pr, error, e instanceof PostUpdateError ? e.key : undefined)
      } catch (ce) {
        comment = `\nand cannot comment on #${outcome.pr}: ${errorText(ce)}`
      }
    }
    outcomes.push({ ...outcome, action: 'error', error: error + comment })
  }

  /** Commits the unit, with the files that the post_update commands changed. */
  const commit = async (result: UnitResult) => {
    const generated = ctx.generate ? await ctx.generate(result) : []
    const sha = await github.createCommit({
      baseSha: ctx.baseSha,
      baseTree: ctx.baseTree,
      files: result.files,
      generated,
      message: commitMessage(result),
    })
    return { sha, generated: generated.length }
  }

  const body = (result: UnitResult, sha: string, generated: number, previous?: string) => {
    const infos = new Map(Object.entries(result.changes).map(([name, c]) => [name, ctx.packageInfo(name, c.to)]))
    return renderBody(result, metaOf(result, ctx.hashes, sha, previous), infos, generated)
  }

  // close runs last, so that the pull request that supersedes it has a number.
  const ordered = [...ops.filter((o) => o.op !== 'close'), ...ops.filter((o) => o.op === 'close')]
  for (const op of ordered) {
    switch (op.op) {
      case 'create': {
        const base = { kind: op.result.unit.kind, packages: unitPackages(op.result) }
        let pr: number | undefined
        ctx.info(`Create a pull request (${base.kind}: ${base.packages.join(', ')}) on ${op.branch}`)
        try {
          const { sha, generated } = await commit(op.result)
          await github.createBranch(op.branch, sha)
          pr = await github.createPr({
            base: ctx.base,
            branch: op.branch,
            title: title(op.result),
            body: body(op.result, sha, generated),
          })
          numbers.set(op.branch, pr)
          ctx.info(`Created #${pr}`)
          await github.addLabels(pr, await labels())
          outcomes.push({ ...base, action: 'created', pr })
        } catch (e) {
          await fail({ ...base, pr }, e)
        }
        break
      }
      case 'regenerate': {
        const { pr, result } = op
        const base = { kind: result.unit.kind, packages: unitPackages(result), pr: pr.number }
        numbers.set(pr.branch, pr.number)
        ctx.info(`Regenerate #${pr.number} (${base.packages.join(', ')})`)
        try {
          const { sha, generated } = await commit(result)
          // The body goes first, so that the next run can tell a partial failure from manual commits.
          await github.updatePr(pr.number, { title: title(result), body: body(result, sha, generated, pr.headSha) })
          await github.updateBranch(pr.branch, pr.headSha, sha)
          await github.addLabels(pr.number, await labels())
          if (op.contentChanged && pr.meta) {
            ctx.info(`Comment the content change on #${pr.number}`)
            await github.comment(pr.number, contentChangedComment(pr.meta.packages, result.changes))
          }
          outcomes.push({ ...base, action: 'regenerated' })
        } catch (e) {
          await fail(base, e)
        }
        break
      }
      case 'notifyManual': {
        const { pr } = op
        const base = { kind: prKind(pr), packages: prPackages(pr), pr: pr.number }
        numbers.set(pr.branch, pr.number)
        try {
          const marker = manualMarker(pr.headSha)
          const comments = await github.comments(pr.number)
          if (comments.some((c) => c.isBot && c.body.includes(marker))) {
            ctx.info(`#${pr.number} has manual commits; already notified`)
          } else {
            ctx.info(`#${pr.number} has manual commits; notify`)
            await github.comment(pr.number, manualComment(pr.headSha))
          }
          outcomes.push({ ...base, action: 'notified' })
        } catch (e) {
          outcomes.push({ ...base, action: 'error', error: errorText(e) })
        }
        break
      }
      case 'commentError': {
        const { pr } = op
        numbers.set(pr.branch, pr.number)
        await fail({ kind: prKind(pr), packages: prPackages(pr), pr: pr.number }, op.log)
        break
      }
      case 'error':
        await fail({ kind: op.unit.kind, packages: op.unit.members }, op.log)
        break
      case 'none':
        numbers.set(op.pr.branch, op.pr.number)
        ctx.info(`#${op.pr.number} is up to date`)
        outcomes.push({ kind: prKind(op.pr), packages: prPackages(op.pr), action: 'unchanged', pr: op.pr.number })
        break
      case 'skip':
        ctx.info(`Skip ${unitPackages(op.result).join(', ')}: the same update was closed in #${op.closedPr.number}`)
        outcomes.push({
          kind: op.result.unit.kind,
          packages: unitPackages(op.result),
          action: 'skipped',
          pr: op.closedPr.number,
        })
        break
      case 'close': {
        const { pr } = op
        const base = { kind: prKind(pr), packages: prPackages(pr), pr: pr.number }
        try {
          const supersededBy = op.supersededBy === undefined ? undefined : numbers.get(op.supersededBy)
          ctx.info(`Close #${pr.number}${supersededBy === undefined ? '' : ` (superseded by #${supersededBy})`}`)
          await github.comment(pr.number, closeComment(supersededBy))
          // closed: true tells a later run that pubreform, not a person, closed it.
          await github.closePr(pr.number, markClosed(pr.body))
          await github.deleteBranch(pr.branch)
          outcomes.push({ ...base, action: 'closed' })
        } catch (e) {
          await fail(base, e)
        }
        break
      }
    }
  }
  return outcomes
}
