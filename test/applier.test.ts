import { describe, expect, test } from 'bun:test'
import { applyArgs, applyUnit } from '../src/applier.ts'
import type { Advisory, Fix } from '../src/advisories.ts'
import type { Unit } from '../src/planner.ts'
import type { DirectDep } from '../src/pubspec.ts'

const deps: DirectDep[] = [
  { name: 'http', section: 'dependencies', constraint: '^1.5.0', current: '1.5.0' },
  { name: 'lints', section: 'dev_dependencies', constraint: '^5.0.0', current: '5.0.0' },
  { name: 'meta', section: 'dependencies', constraint: '^1.16.0', current: '1.16.0' },
]

const lock = (versions: Record<string, string>) =>
  'packages:\n' +
  Object.entries(versions)
    .map(
      ([name, v]) =>
        `  ${name}:\n    dependency: "direct main"\n    description:\n      name: ${name}\n      sha256: "00"\n      url: "https://pub.dev"\n    source: hosted\n    version: "${v}"\n`,
    )
    .join('')

const base = { pubspec: 'name: app\n', lock: lock({ http: '1.5.0', lints: '5.0.0', meta: '1.16.0', async: '2.13.0' }) }

describe('applyArgs', () => {
  test('minor', () => {
    const unit: Unit = { kind: 'minor', members: ['http'], targets: {} }
    expect(applyArgs(unit, deps, 'increase')).toEqual([['upgrade', '--tighten']])
    expect(applyArgs(unit, deps, 'lockfile-only')).toEqual([['upgrade']])
  })
  test('minor raises pinned versions before upgrading', () => {
    const pinned = deps.map((d) => (d.name === 'meta' ? d : { ...d, constraint: d.current }))
    const unit: Unit = { kind: 'minor', members: ['http', 'lints', 'meta'], targets: { http: '1.6.0', lints: '5.1.0' } }
    const add = ['add', 'http:1.6.0', 'dev:lints:5.1.0']
    expect(applyArgs(unit, pinned, 'increase')).toEqual([add, ['upgrade', '--tighten']])
    expect(applyArgs(unit, pinned, 'lockfile-only')).toEqual([add, ['upgrade']])
  })
  test('group with a dev dependency', () => {
    const unit: Unit = { kind: 'group', members: ['http', 'lints'], targets: { http: '2.0.0', lints: '6.0.0+1' } }
    expect(applyArgs(unit, deps, 'increase')).toEqual([['add', 'http:^2.0.0', 'dev:lints:^6.0.0+1']])
  })
  test('pinned versions stay pinned', () => {
    const pinned = deps.map((d) => (d.name === 'lints' ? { ...d, constraint: '5.0.0' } : d))
    const unit: Unit = { kind: 'group', members: ['http', 'lints'], targets: { http: '2.0.0', lints: '6.0.0' } }
    expect(applyArgs(unit, pinned, 'increase')).toEqual([['add', 'http:^2.0.0', 'dev:lints:6.0.0']])
  })
  test('single with a pinned dependency that it moves', () => {
    const pinned = deps.map((d) => (d.name === 'lints' ? { ...d, constraint: '5.0.0' } : d))
    const unit: Unit = { kind: 'single', members: ['http'], targets: { http: '2.0.0', lints: '5.0.1' } }
    expect(applyArgs(unit, pinned, 'increase')).toEqual([['add', 'http:^2.0.0', 'dev:lints:5.0.1']])
  })
})

describe('applyUnit', () => {
  test('returns the changes of direct dependencies only', async () => {
    const unit: Unit = { kind: 'single', members: ['lints'], targets: { lints: '6.0.0' } }
    const calls: string[][] = []
    const result = await applyUnit(unit, {
      base,
      deps,
      versioning: 'increase',
      fixes: new Map(),
      cutoff: new Date(),
      pub: async (args, files) => {
        calls.push(args)
        expect(files).toBe(base)
        return { pubspec: 'changed\n', lock: lock({ http: '1.5.0', lints: '6.0.0', meta: '1.17.0', async: '2.14.0' }) }
      },
    })
    expect(calls).toEqual([['add', 'dev:lints:^6.0.0']])
    expect(result).toEqual({
      unit,
      files: { pubspec: 'changed\n', lock: lock({ http: '1.5.0', lints: '6.0.0', meta: '1.17.0', async: '2.14.0' }) },
      changes: {
        lints: { from: '5.0.0', to: '6.0.0', section: 'dev_dependencies' },
        meta: { from: '1.16.0', to: '1.17.0', section: 'dependencies' },
      },
      transitiveFixes: {},
      advisories: [],
    })
  })
  test('runs each command on the files that the previous one wrote', async () => {
    const pinned = deps.map((d) => (d.name === 'http' ? { ...d, constraint: '1.5.0' } : d))
    const unit: Unit = { kind: 'minor', members: ['http', 'meta'], targets: { http: '1.6.0' } }
    const added = { pubspec: 'added\n', lock: lock({ http: '1.6.0', lints: '5.0.0', meta: '1.16.0', async: '2.13.0' }) }
    const upgraded = { pubspec: 'upgraded\n', lock: lock({ http: '1.6.0', lints: '5.0.0', meta: '1.17.0', async: '2.13.0' }) }
    const calls: [string[], unknown][] = []
    const result = await applyUnit(unit, {
      base,
      deps: pinned,
      versioning: 'increase',
      fixes: new Map(),
      cutoff: new Date(),
      pub: async (args, files) => {
        calls.push([args, files])
        return args[0] === 'add' ? added : upgraded
      },
    })
    expect(calls).toEqual([
      [['add', 'http:1.6.0'], base],
      [['upgrade', '--tighten'], added],
    ])
    expect(result!.files).toBe(upgraded)
    expect(Object.keys(result!.changes)).toEqual(['http', 'meta'])
  })
  test('returns undefined when no direct dependency changes', async () => {
    const unit: Unit = { kind: 'minor', members: ['http'], targets: {} }
    const result = await applyUnit(unit, {
      base,
      deps,
      versioning: 'increase',
      fixes: new Map(),
      cutoff: new Date(),
      pub: async () => ({ pubspec: base.pubspec, lock: lock({ http: '1.5.0', lints: '5.0.0', meta: '1.16.0', async: '2.14.0' }) }),
    })
    expect(result).toBeUndefined()
  })

  describe('security advisories', () => {
    const adv = (id: string): Advisory => ({ id, aliases: [], versions: new Set() })
    const cutoff = new Date('2026-10-10T00:00:00Z')
    const fixes = new Map<string, Fix>([
      // A direct dependency, fixed by a version shown before the cutoff.
      ['http', { name: 'http', locked: '1.5.0', advisories: [adv('GHSA-a'), adv('GHSA-b')], affected: new Set(['1.5.0', '1.6.0']), fix: { version: '1.5.1', published: new Date('2026-10-18T00:00:00Z') } }],
      // A transitive dependency, fixed by an old version.
      ['async', { name: 'async', locked: '2.13.0', advisories: [adv('GHSA-c')], affected: new Set(['2.13.0']), fix: { version: '2.13.1', published: new Date('2026-01-01T00:00:00Z') } }],
      // Moved, but to another affected version.
      ['path', { name: 'path', locked: '1.0.0', advisories: [adv('GHSA-d')], affected: new Set(['1.0.0', '1.1.0']) }],
    ])
    const baseWith = { pubspec: 'name: app\n', lock: lock({ http: '1.5.0', lints: '5.0.0', meta: '1.16.0', async: '2.13.0', path: '1.0.0' }) }
    const apply = (unit: Unit, versions: Record<string, string>) =>
      applyUnit(unit, {
        base: baseWith,
        deps,
        versioning: 'increase',
        pub: async () => ({ pubspec: 'changed\n', lock: lock(versions) }),
        fixes,
        cutoff,
      })

    test('fixed transitive dependencies and advisories', async () => {
      const unit: Unit = { kind: 'minor', members: ['http'], targets: {} }
      const result = (await apply(unit, { http: '1.5.1', lints: '5.0.0', meta: '1.16.0', async: '2.13.1', path: '1.1.0' }))!
      expect(result.changes).toEqual({ http: { from: '1.5.0', to: '1.5.1', section: 'dependencies' } })
      expect(result.transitiveFixes).toEqual({ async: { from: '2.13.0', to: '2.13.1' } })
      expect(result.advisories).toEqual([
        { package: 'async', advisory: adv('GHSA-c'), from: '2.13.0', to: '2.13.1' },
        { package: 'http', advisory: adv('GHSA-a'), from: '1.5.0', to: '1.5.1', early: new Date('2026-10-18T00:00:00Z') },
        { package: 'http', advisory: adv('GHSA-b'), from: '1.5.0', to: '1.5.1', early: new Date('2026-10-18T00:00:00Z') },
      ])
    })
    test('early only for the fixed version', async () => {
      const unit: Unit = { kind: 'single', members: ['http'], targets: { http: '2.0.0' } }
      const result = (await apply(unit, { http: '2.0.0', lints: '5.0.0', meta: '1.16.0', async: '2.13.0', path: '1.0.0' }))!
      expect(result.advisories.map((a) => [a.advisory.id, a.to, a.early])).toEqual([
        ['GHSA-a', '2.0.0', undefined],
        ['GHSA-b', '2.0.0', undefined],
      ])
      expect(result.transitiveFixes).toEqual({})
    })
    test('kept when only a fixed transitive dependency changes', async () => {
      const unit: Unit = { kind: 'minor', members: [], targets: {} }
      const result = (await apply(unit, { http: '1.5.0', lints: '5.0.0', meta: '1.16.0', async: '2.13.1', path: '1.0.0' }))!
      expect(result.changes).toEqual({})
      expect(Object.keys(result.transitiveFixes)).toEqual(['async'])
    })
    test('dropped when only unfixed or unrelated transitive dependencies change', async () => {
      const unit: Unit = { kind: 'minor', members: [], targets: {} }
      expect(await apply(unit, { http: '1.5.0', lints: '5.0.0', meta: '1.16.0', async: '2.13.0', path: '1.1.0', other: '1.0.0' })).toBeUndefined()
    })
  })
})
