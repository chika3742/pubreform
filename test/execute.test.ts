import { describe, expect, test } from 'bun:test'
import type { UnitResult } from '../src/applier.ts'
import type { Comment } from '../src/github.ts'
import { type ExecuteContext, type Op, type PrState, execute } from '../src/reconciler.ts'
import { errorComment, parseMeta, renderMeta } from '../src/render.ts'

const http: UnitResult = {
  unit: { kind: 'single', members: ['http'], targets: { http: '2.0.0' } },
  files: { pubspec: 'p', lock: 'l' },
  changes: { http: { from: '1.5.0', to: '2.0.0', section: 'dependencies' } },
}
const group: UnitResult = {
  unit: { kind: 'group', members: ['a', 'b'], targets: {} },
  files: { pubspec: 'p', lock: 'l' },
  changes: {
    a: { from: '1.0.0', to: '2.0.0', section: 'dependencies' },
    b: { from: '1.0.0', to: '2.0.0', section: 'dependencies' },
  },
}
const prOf = (number: number, branch: string, extra: Partial<PrState> = {}): PrState => ({
  number,
  branch,
  headSha: 'head',
  title: 't',
  body: '',
  ...extra,
})

function fakeGitHub(options: { fail?: string; comments?: Comment[]; heads?: Record<string, string> } = {}) {
  const calls: string[] = []
  let nextPr = 100
  const comments = new Map<number, Comment[]>()
  const record = (name: string, ...args: unknown[]) => {
    calls.push(`${name} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`)
    if (options.fail && name === options.fail) throw new Error(`${name} failed`)
  }
  const github: ExecuteContext['github'] = {
    async createCommit(o) {
      record('createCommit', o.message.split('\n')[0])
      return 'newsha'
    },
    async createBranch(branch, sha) {
      record('createBranch', branch, sha)
    },
    async updateBranch(branch, expected, sha) {
      record('updateBranch', branch, expected, sha)
      if (options.heads && options.heads[branch] !== expected) throw new Error(`branch ${branch} has moved`)
    },
    async deleteBranch(branch) {
      record('deleteBranch', branch)
    },
    async createPr(o) {
      record('createPr', o.branch, o.title)
      return nextPr++
    },
    async updatePr(n, o) {
      record('updatePr', n, o.title)
    },
    async closePr(n, body) {
      record('closePr', n, parseMeta(body)?.closed === true ? 'meta closed' : 'no meta')
    },
    async ensureLabels(labels) {
      record('ensureLabels', labels)
      return labels
    },
    async addLabels(n, labels) {
      record('addLabels', n, labels)
    },
    async comments(n) {
      record('comments', n)
      return [...(options.comments ?? []), ...(comments.get(n) ?? [])]
    },
    async comment(n, body) {
      record('comment', n, body.split('\n')[0])
      comments.set(n, [...(comments.get(n) ?? []), { body, isBot: true }])
    },
  }
  return { github, calls, comments }
}

function context(github: ExecuteContext["github"]): ExecuteContext {
  return {
    github,
    base: 'main',
    baseSha: 'basesha',
    baseTree: 'basetree',
    hashes: { baseHash: 'bh', configHash: 'ch' },
    labels: ['dependencies'],
    packageInfo: () => ({}),
    formatLog: (log) => log.replaceAll('secret', '***'),
    log: () => {},
  }
}

describe('execute', () => {
  test('create, then close superseded with the new number', async () => {
    const { github, calls } = fakeGitHub()
    const ops: Op[] = [
      {
        op: 'close',
        pr: prOf(7, 'pubreform/single/a', {
          body: `text\n${renderMeta({ v: 1, kind: 'single', packages: { a: ['1.0.0', '2.0.0'] }, baseHash: 'x', configHash: 'y', commit: 'head' })}\n`,
        }),
        supersededBy: 'pubreform/group/a',
      },
      { op: 'create', result: group, branch: 'pubreform/group/a' },
    ]
    const outcomes = await execute(ops, context(github))
    expect(calls).toEqual([
      'createCommit Update 2 packages',
      'createBranch pubreform/group/a newsha',
      'createPr pubreform/group/a Update 2 packages',
      'ensureLabels ["dependencies"]',
      'addLabels 100 ["dependencies"]',
      'comment 7 Closing: superseded by #100.',
      'closePr 7 meta closed',
      'deleteBranch pubreform/single/a',
    ])
    expect(outcomes).toEqual([
      { kind: 'group', packages: ['a', 'b'], action: 'created', pr: 100 },
      { kind: undefined, packages: ['a'], action: 'closed', pr: 7 },
    ])
  })

  test('regenerate checks the head, updates the body with the new commit, and comments a content change', async () => {
    const { github, calls } = fakeGitHub({ heads: { 'pubreform/single/http': 'head' } })
    const pr = prOf(3, 'pubreform/single/http', {
      meta: { v: 1, kind: 'single', packages: { http: ['1.5.0', '1.9.0'] }, baseHash: 'x', configHash: 'y', commit: 'head' },
    })
    let body = ''
    github.updatePr = async (_n, o) => {
      calls.push('updatePr')
      body = o.body
    }
    const outcomes = await execute([{ op: 'regenerate', pr, result: http, contentChanged: true }], context(github))
    expect(calls).toEqual([
      'createCommit Update http from 1.5.0 to 2.0.0',
      'updatePr',
      'updateBranch pubreform/single/http head newsha',
      'ensureLabels ["dependencies"]',
      'addLabels 3 ["dependencies"]',
      'comment 3 The update in this PR has changed.',
    ])
    expect(parseMeta(body)).toEqual({
      v: 1,
      kind: 'single',
      packages: { http: ['1.5.0', '2.0.0'] },
      baseHash: 'bh',
      configHash: 'ch',
      commit: 'newsha',
      previous: 'head',
    })
    expect(outcomes).toEqual([{ kind: 'single', packages: ['http'], action: 'regenerated', pr: 3 }])
  })

  test('a moved branch is an error commented on the pull request', async () => {
    const { github, calls } = fakeGitHub({ heads: { 'pubreform/single/http': 'someone-else' } })
    const pr = prOf(3, 'pubreform/single/http')
    const outcomes = await execute([{ op: 'regenerate', pr, result: http, contentChanged: false }], context(github))
    expect(calls).toContain('comment 3 pubreform failed to update this PR.')
    expect(calls).toContain('updatePr 3 Update http from 1.5.0 to 2.0.0')
    // The body is updated first, so the next run sees head == meta.previous and regenerates.
    expect(calls.indexOf('updatePr 3 Update http from 1.5.0 to 2.0.0')).toBeLessThan(
      calls.indexOf('updateBranch pubreform/single/http head newsha'),
    )
    expect(outcomes[0]).toMatchObject({ action: 'error', pr: 3, error: 'branch pubreform/single/http has moved' })
  })

  test('the same error is not commented twice, and secrets are masked', async () => {
    const { github, calls } = fakeGitHub({ comments: [{ body: errorComment('pub failed: ***'), isBot: true }] })
    const pr = prOf(5, 'pubreform/minor-and-patch')
    const outcomes = await execute([{ op: 'commentError', pr, log: 'pub failed: secret' }], context(github))
    expect(calls).toEqual(['comments 5'])
    expect(outcomes[0]).toMatchObject({ action: 'error', pr: 5 })

    const other = fakeGitHub({ comments: [{ body: errorComment('older error'), isBot: true }] })
    await execute([{ op: 'commentError', pr, log: 'pub failed: secret' }], context(other.github))
    expect(other.calls).toEqual(['comments 5', 'comment 5 pubreform failed to update this PR.'])
    expect(other.comments.get(5)![0]!.body).toContain('pub failed: ***')
  })

  test('manual commits are notified once per head', async () => {
    const pr = prOf(9, 'pubreform/single/http', { headSha: 'h2' })
    const first = fakeGitHub()
    await execute([{ op: 'notifyManual', pr }], context(first.github))
    expect(first.calls).toEqual(['comments 9', 'comment 9 This PR has commits that pubreform did not create, so pubreform will not update it automatically. Check "Rebase this PR" to discard those commits and regenerate it.'])
    const again = fakeGitHub({ comments: first.comments.get(9) })
    await execute([{ op: 'notifyManual', pr }], context(again.github))
    expect(again.calls).toEqual(['comments 9'])
  })

  test('a failed create without a pull request is only recorded', async () => {
    const { github, calls } = fakeGitHub({ fail: 'createBranch' })
    const outcomes = await execute([{ op: 'create', result: http, branch: 'pubreform/single/http' }], context(github))
    expect(calls).toEqual(['createCommit Update http from 1.5.0 to 2.0.0', 'createBranch pubreform/single/http newsha'])
    expect(outcomes).toEqual([
      { kind: 'single', packages: ['http'], pr: undefined, action: 'error', error: 'createBranch failed' },
    ])
  })
})
