import { describe, expect, test } from 'bun:test'
import type { UnitResult } from '../src/applier.ts'
import type { Unit } from '../src/planner.ts'
import type { Fix } from '../src/advisories.ts'
import { type Outcome, type PrState, advisoryStatus, decide } from '../src/reconciler.ts'
import { type Meta, REBASE_LINE, branchName, renderMeta } from '../src/render.ts'

const ctx = { baseHash: 'base', configHash: 'config' }

function result(kind: Unit['kind'], changes: Record<string, [string, string]>, members = Object.keys(changes)): UnitResult {
  return {
    unit: { kind, members, targets: {} },
    files: { pubspec: '', lock: '' },
    changes: Object.fromEntries(
      Object.entries(changes).map(([name, [from, to]]) => [name, { from, to, section: 'dependencies' as const }]),
    ),
    transitiveFixes: {},
    advisories: [],
  }
}

let nextNumber = 1
function pr(r: UnitResult, overrides: Omit<Partial<PrState>, 'meta'> & { meta?: Partial<Meta> | null } = {}): PrState {
  const { meta: metaOverrides, ...rest } = overrides
  const meta: Meta | undefined =
    metaOverrides === null
      ? undefined
      : {
          v: 1,
          kind: r.unit.kind,
          packages: Object.fromEntries(Object.entries(r.changes).map(([n, c]) => [n, [c.from, c.to]])),
          baseHash: 'base',
          configHash: 'config',
          commit: 'c1',
          ...metaOverrides,
        }
  return {
    number: nextNumber++,
    branch: branchName(r.unit),
    headSha: 'c1',
    title: 't',
    body: `${REBASE_LINE}\n${meta ? renderMeta(meta) : ''}`,
    meta,
    mergeable: true,
    mergeableState: 'clean',
    ...rest,
  }
}

const http = result('single', { http: ['1.5.0', '2.0.0'] })
const minor = result('minor', { lints: ['6.0.0', '6.1.0'], meta: ['1.16.0', '1.17.0'] })
const group = result('group', { a: ['1.0.0', '2.0.0'], b: ['1.0.0', '2.0.0'] })
const noUncertain = { uncertain: new Set<string>() }

describe('decide: units without pull requests', () => {
  test('create', () => {
    expect(decide([http, group], [], noUncertain, [], [], ctx)).toEqual([
      { op: 'create', result: http, branch: 'pubreform/single/http' },
      { op: 'create', result: group, branch: 'pubreform/group/a' },
    ])
  })
  test('skip when the same update was closed without merging', () => {
    const closed = pr(http, { number: 50 })
    const otherKind = pr(result('group', { http: ['1.5.0', '2.0.0'] }))
    const otherVersion = pr(result('single', { http: ['1.5.0', '2.0.1'] }))
    expect(decide([http], [], noUncertain, [], [otherKind, otherVersion], ctx)[0]!.op).toBe('create')
    expect(decide([http], [], noUncertain, [], [otherKind, closed], ctx)).toEqual([
      { op: 'skip', result: http, closedPr: closed },
    ])
  })
  test('a pull request that pubreform closed does not stop the same update', () => {
    const closedByPubreform = pr(http, { meta: { closed: true } })
    expect(decide([http], [], noUncertain, [], [closedByPubreform], ctx)).toEqual([
      { op: 'create', result: http, branch: 'pubreform/single/http' },
    ])
  })
  test('a closed pull request with extra packages is not the same update', () => {
    const closed = pr(result('minor', { lints: ['6.0.0', '6.1.0'], meta: ['1.16.0', '1.17.0'], x: ['1.0.0', '1.1.0'] }))
    expect(decide([minor], [], noUncertain, [], [closed], ctx)[0]!.op).toBe('create')
  })
  test('only the to versions are compared with closed pull requests', () => {
    const closed = pr(result('minor', { lints: ['5.0.0', '6.1.0'], meta: ['1.15.0', '1.17.0'] }))
    expect(decide([minor], [], noUncertain, [], [closed], ctx)[0]!.op).toBe('skip')
  })
  test('apply error without a pull request', () => {
    expect(decide([], [{ unit: http.unit, log: 'boom' }], noUncertain, [], [], ctx)).toEqual([
      { op: 'error', unit: http.unit, log: 'boom' },
    ])
  })
})

describe('decide: units with pull requests', () => {
  const op = (r: UnitResult, p: PrState) => decide([r], [], noUncertain, [p], [], ctx)
  test('none when nothing changed', () => {
    const p = pr(http)
    expect(op(http, p)).toEqual([{ op: 'none', pr: p, result: http }])
  })
  test('manual commits', () => {
    const p = pr(http, { headSha: 'other' })
    expect(op(http, p)).toEqual([{ op: 'notifyManual', pr: p, result: http }])
  })
  test('head at meta.commit after a regeneration is not a manual commit', () => {
    const p = pr(http, { headSha: 'c2', meta: { commit: 'c2', previous: 'c1' } })
    expect(op(http, p)).toEqual([{ op: 'none', pr: p, result: http }])
  })
  test('head still at meta.previous: the last regeneration stopped before moving the branch', () => {
    const p = pr(http, { headSha: 'c1', meta: { commit: 'c2', previous: 'c1' } })
    expect(op(http, p)).toEqual([{ op: 'regenerate', pr: p, result: http, contentChanged: false }])
  })
  test('head different from both commit and previous is a manual commit', () => {
    const p = pr(http, { headSha: 'c3', meta: { commit: 'c2', previous: 'c1' } })
    expect(op(http, p)).toEqual([{ op: 'notifyManual', pr: p, result: http }])
  })
  test('checked box regenerates even with manual commits', () => {
    const p = pr(http, { headSha: 'other' })
    p.body = p.body.replace('- [ ]', '- [x]')
    expect(op(http, p)).toEqual([{ op: 'regenerate', pr: p, result: http, contentChanged: false }])
  })
  test('conflict', () => {
    const p = pr(http, { mergeable: false, mergeableState: 'dirty' })
    expect(op(http, p)[0]!.op).toBe('regenerate')
    expect(op(http, pr(http, { mergeable: null, mergeableState: 'unknown' }))[0]!.op).toBe('none')
  })
  test('content changed', () => {
    const p = pr(result('single', { http: ['1.5.0', '1.9.0'] }))
    expect(op(http, p)).toEqual([{ op: 'regenerate', pr: p, result: http, contentChanged: true }])
  })
  test('only from changed is not a content change', () => {
    const p = pr(result('minor', { lints: ['5.0.0', '6.1.0'], meta: ['1.16.0', '1.17.0'] }))
    expect(op(minor, p)).toEqual([{ op: 'none', pr: p, result: minor }])
  })
  test('base or config changed', () => {
    expect(op(http, pr(http, { meta: { baseHash: 'old' } }))[0]).toMatchObject({ op: 'regenerate', contentChanged: false })
    expect(op(http, pr(http, { meta: { configHash: 'old' } }))[0]).toMatchObject({ op: 'regenerate', contentChanged: false })
  })
  test('no metadata', () => {
    expect(op(http, pr(http, { meta: null, headSha: 'anything' }))[0]).toMatchObject({ op: 'regenerate', contentChanged: false })
  })
  test('apply error with a pull request', () => {
    const p = pr(http)
    expect(decide([], [{ unit: http.unit, log: 'boom' }], noUncertain, [p], [], ctx)).toEqual([
      { op: 'commentError', pr: p, log: 'boom' },
    ])
  })
})

describe('decide: security advisories', () => {
  const op = (r: UnitResult, p: PrState) => decide([r], [], noUncertain, [p], [], ctx)
  const fixed: UnitResult = {
    ...http,
    advisories: [{ package: 'http', advisory: { id: 'GHSA-1', aliases: [], versions: new Set() }, from: '1.5.0', to: '2.0.0' }],
  }
  test('refresh when only the advisories changed', () => {
    const p = pr(http)
    expect(op(fixed, p)).toEqual([{ op: 'refresh', pr: p, result: fixed }])
    const q = pr(http, { meta: { advisories: ['GHSA-1'] } })
    expect(op(http, q)).toEqual([{ op: 'refresh', pr: q, result: http }])
    const same = pr(http, { meta: { advisories: ['GHSA-1'] } })
    expect(op(fixed, same)).toEqual([{ op: 'none', pr: same, result: fixed }])
  })
  test('regenerate and notifyManual come first', () => {
    const changed = pr(http, { meta: { baseHash: 'old' } })
    expect(op(fixed, changed)).toEqual([{ op: 'regenerate', pr: changed, result: fixed, contentChanged: false }])
    const manual = pr(http, { headSha: 'other' })
    expect(op(fixed, manual)).toEqual([{ op: 'notifyManual', pr: manual, result: fixed }])
  })
})

describe('advisoryStatus', () => {
  const fix: Fix = { name: 'x', locked: '1.0.0', advisories: [], affected: new Set(['1.0.0']), fix: { version: '1.0.1' } }
  const o = (action: Outcome['action'], pr?: number, fixes = ['x']): Outcome => ({ kind: 'minor', packages: [], action, pr, fixes })
  const none = { direct: new Set(['x']), uncertain: new Set<string>(), failed: new Set<string>(), minorFailed: false }
  test('in order', () => {
    expect(advisoryStatus({ ...fix, fix: undefined }, [o('created', 1)], false, none)).toBe('No fixed version')
    expect(advisoryStatus(fix, [o('created', 1)], true, none)).toBe('No fixed version')
    expect(advisoryStatus(fix, [o('unchanged', 5), o('refreshed', 2), o('notified', 7), o('skipped', 3), o('error', 4)], false, none)).toBe(
      'Fixed in #2, #5',
    )
    expect(advisoryStatus(fix, [o('regenerated', 6)], false, none)).toBe('Fixed in #6')
    expect(advisoryStatus(fix, [o('notified', 7), o('skipped', 3)], false, none)).toBe('Not updated in #7 (manual commits)')
    expect(advisoryStatus(fix, [o('skipped', 3), o('error', 4)], false, none)).toBe('Closed in #3')
    expect(advisoryStatus(fix, [o('error', undefined), o('created', 1, ['y'])], false, none)).toBe('Error')
    expect(advisoryStatus(fix, [], false, none)).toBe('Cannot be fixed with the current constraints')
  })
  test('Error when the package failed to plan or apply', () => {
    expect(advisoryStatus(fix, [], false, { ...none, uncertain: new Set(['x']) })).toBe('Error')
    expect(advisoryStatus(fix, [], false, { ...none, failed: new Set(['x']) })).toBe('Error')
    // A failed minor unit counts only for transitive dependencies.
    expect(advisoryStatus(fix, [], false, { ...none, minorFailed: true })).toBe('Cannot be fixed with the current constraints')
    const transitive = { ...none, direct: new Set<string>() }
    expect(advisoryStatus(fix, [], false, { ...transitive, minorFailed: true })).toBe('Error')
    expect(advisoryStatus(fix, [], false, { ...transitive, failed: new Set(['x']) })).toBe('Cannot be fixed with the current constraints')
  })
})

describe('decide: group matching', () => {
  test('a group keeps its branch when members change', () => {
    const old = pr(result('group', { x: ['1.0.0', '2.0.0'], a: ['1.0.0', '2.0.0'] }), { branch: 'pubreform/group/x' })
    const now = result('group', { a: ['1.0.0', '2.0.0'], b: ['1.0.0', '2.0.0'] })
    expect(decide([now], [], noUncertain, [old], [], ctx)).toEqual([
      { op: 'regenerate', pr: old, result: now, contentChanged: true },
    ])
  })
  test('largest overlap first, then the smaller number; the other one is closed', () => {
    const p1 = pr(result('group', { a: ['1.0.0', '2.0.0'], c: ['1.0.0', '2.0.0'] }), { number: 101, branch: 'pubreform/group/a' })
    const p2 = pr(result('group', { a: ['1.0.0', '2.0.0'], b: ['1.0.0', '2.0.0'] }), { number: 102, branch: 'pubreform/group/b' })
    const ops = decide([group], [], noUncertain, [p1, p2], [], ctx)
    expect(ops).toEqual([
      { op: 'none', pr: p2, result: group },
      { op: 'close', pr: p1, supersededBy: 'pubreform/group/b' },
    ])
  })
  test('equal overlap goes to the smaller number', () => {
    const p1 = pr(result('group', { a: ['1.0.0', '2.0.0'], c: ['1.0.0', '2.0.0'] }), { number: 201, branch: 'pubreform/group/a' })
    const p2 = pr(result('group', { b: ['1.0.0', '2.0.0'], d: ['1.0.0', '2.0.0'] }), { number: 202, branch: 'pubreform/group/b' })
    const ops = decide([group], [], noUncertain, [p2, p1], [], ctx)
    expect(ops[0]).toMatchObject({ op: 'regenerate', pr: p1 })
    expect(ops[1]).toEqual({ op: 'close', pr: p2, supersededBy: 'pubreform/group/a' })
  })
  test('a group pull request without metadata matches by the first package in the branch', () => {
    const p = pr(group, { meta: null, branch: 'pubreform/group/b' })
    expect(decide([group], [], noUncertain, [p], [], ctx)[0]).toMatchObject({ op: 'regenerate', pr: p })
  })
})

describe('decide: pull requests without units', () => {
  test('close when no longer needed', () => {
    const p = pr(http)
    expect(decide([], [], noUncertain, [p], [], ctx)).toEqual([{ op: 'close', pr: p, supersededBy: undefined }])
  })
  test('superseded by a new group', () => {
    const p = pr(result('single', { a: ['1.0.0', '2.0.0'] }))
    expect(decide([group], [], noUncertain, [p], [], ctx)).toEqual([
      { op: 'create', result: group, branch: 'pubreform/group/a' },
      { op: 'close', pr: p, supersededBy: 'pubreform/group/a' },
    ])
  })
  test('not closed when the unit that takes over its package failed to apply', () => {
    const p = pr(result('single', { b: ['1.0.0', '2.0.0'] }))
    expect(decide([], [{ unit: group.unit, log: 'boom' }], noUncertain, [p], [], ctx)).toEqual([
      { op: 'error', unit: group.unit, log: 'boom' },
      { op: 'none', pr: p },
    ])
  })
  test('not closed when planning of its package failed', () => {
    const p = pr(http)
    expect(decide([], [], { uncertain: new Set(['http']) }, [p], [], ctx)).toEqual([{ op: 'none', pr: p }])
    const noMeta = pr(http, { meta: null })
    expect(decide([], [], { uncertain: new Set(['http']) }, [noMeta], [], ctx)).toEqual([{ op: 'none', pr: noMeta }])
  })
})
