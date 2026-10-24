import { describe, expect, test } from 'bun:test'
import { applyPub, applyUnit } from '../src/applier.ts'
import type { Advisory, Fix } from '../src/advisories.ts'
import type { Unit } from '../src/planner.ts'
import type { PubFiles } from '../src/pub.ts'
import type { DirectDep } from '../src/pubspec.ts'

const dep = (name: string, section: DirectDep['section'], constraint: string, current: string): DirectDep => ({
  name,
  section,
  declarations: [{ path: 'pubspec.yaml', section, constraint }],
  current,
})
const deps: DirectDep[] = [
  dep('http', 'dependencies', '^1.5.0', '1.5.0'),
  dep('lints', 'dev_dependencies', '^5.0.0', '5.0.0'),
  dep('meta', 'dependencies', '^1.16.0', '1.16.0'),
]

const lock = (versions: Record<string, string>) =>
  'packages:\n' +
  Object.entries(versions)
    .map(
      ([name, v]) =>
        `  ${name}:\n    dependency: "direct main"\n    description:\n      name: ${name}\n      sha256: "00"\n      url: "https://pub.dev"\n    source: hosted\n    version: "${v}"\n`,
    )
    .join('')

const base = { pubspecs: { 'pubspec.yaml': 'name: app\n' }, lock: lock({ http: '1.5.0', lints: '5.0.0', meta: '1.16.0', async: '2.13.0' }) }

describe('applyPub', () => {
  const recorder = () => {
    const calls: { args: string[]; pubspecs: Record<string, string> }[] = []
    const pub = async (args: string[], files: PubFiles) => {
      calls.push({ args, pubspecs: files.pubspecs })
      return files
    }
    return { calls, pub }
  }
  test('minor', async () => {
    const unit: Unit = { kind: 'minor', members: ['http'], targets: {} }
    const { calls, pub } = recorder()
    await applyPub(unit, base, 'increase', pub)
    await applyPub(unit, base, 'lockfile-only', pub)
    expect(calls.map((c) => c.args)).toEqual([['upgrade', '--tighten'], ['upgrade']])
  })
  test('minor moves pinned versions to their targets before upgrading', async () => {
    const unit: Unit = { kind: 'minor', members: ['http', 'lints', 'meta'], targets: { http: '1.6.0', lints: '5.1.0' } }
    const pinned = {
      pubspecs: { 'pubspec.yaml': 'name: app\ndependencies:\n  http: 1.5.0\n  meta: ^1.16.0\ndev_dependencies:\n  lints: 5.0.0\n' },
      lock: base.lock,
    }
    const { calls, pub } = recorder()
    await applyPub(unit, pinned, 'increase', pub)
    expect(calls).toEqual([
      {
        args: ['upgrade', '--tighten'],
        pubspecs: { 'pubspec.yaml': 'name: app\ndependencies:\n  http: 1.6.0\n  meta: ^1.16.0\ndev_dependencies:\n  lints: 5.1.0\n' },
      },
    ])
  })
  test('minor keeps the constraints on workspace members', async () => {
    const unit: Unit = { kind: 'minor', members: ['http'], targets: {} }
    const ws = {
      pubspecs: {
        'pubspec.yaml': 'name: root\nworkspace: [a, b]\n',
        'a/pubspec.yaml': 'name: a\ndependencies:\n  http: ^1.5.0\n',
        'b/pubspec.yaml': 'name: b\ndependencies:\n  a: any\n  http: ^1.5.0\n',
      },
      lock: base.lock,
    }
    const tightened = async (_: string[], files: PubFiles) => ({
      ...files,
      pubspecs: { ...files.pubspecs, 'b/pubspec.yaml': 'name: b\ndependencies:\n  a: ^0.0.0\n  http: ^1.6.0\n' },
    })
    const files = await applyPub(unit, ws, 'increase', tightened)
    expect(files.pubspecs['b/pubspec.yaml']).toBe('name: b\ndependencies:\n  a: any\n  http: ^1.6.0\n')
  })
  test('group: every declaration gets the new constraint, and pub get runs', async () => {
    const unit: Unit = { kind: 'group', members: ['http', 'lints'], targets: { http: '2.0.0', lints: '6.0.0+1' } }
    const ws = {
      pubspecs: {
        'pubspec.yaml': 'name: root\ndev_dependencies:\n  lints: ^5.0.0\n',
        'a/pubspec.yaml': 'name: a\ndependencies:\n  http: ^1.5.0 # c\n',
        'b/pubspec.yaml': 'name: b\ndev_dependencies:\n  http:\n    version: 1.5.0\n',
      },
      lock: base.lock,
    }
    const { calls, pub } = recorder()
    await applyPub(unit, ws, 'increase', pub)
    expect(calls).toEqual([
      {
        args: ['get'],
        pubspecs: {
          'pubspec.yaml': 'name: root\ndev_dependencies:\n  lints: ^6.0.0+1\n',
          'a/pubspec.yaml': 'name: a\ndependencies:\n  http: ^2.0.0 # c\n',
          // A constraint pinned to one version stays pinned.
          'b/pubspec.yaml': 'name: b\ndev_dependencies:\n  http:\n    version: 2.0.0\n',
        },
      },
    ])
  })
  test('single with a pinned dependency that it moves', async () => {
    const unit: Unit = { kind: 'single', members: ['http'], targets: { http: '2.0.0', lints: '5.0.1' } }
    const ws = {
      pubspecs: {
        'pubspec.yaml': 'name: root\ndependencies:\n  http: ^1.5.0\ndev_dependencies:\n  lints: 5.0.0\n',
        // Only the pinned constraint of lints moves: lints is not a member.
        'b/pubspec.yaml': 'name: b\ndev_dependencies:\n  lints: ^5.0.0\n',
      },
      lock: base.lock,
    }
    const { calls, pub } = recorder()
    await applyPub(unit, ws, 'increase', pub)
    expect(calls).toEqual([
      {
        args: ['get'],
        pubspecs: {
          'pubspec.yaml': 'name: root\ndependencies:\n  http: ^2.0.0\ndev_dependencies:\n  lints: 5.0.1\n',
          'b/pubspec.yaml': 'name: b\ndev_dependencies:\n  lints: ^5.0.0\n',
        },
      },
    ])
  })
})

describe('applyUnit', () => {
  test('returns the changes of direct dependencies only', async () => {
    const unit: Unit = { kind: 'minor', members: ['meta'], targets: {} }
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
        return { pubspecs: { 'pubspec.yaml': 'name: changed\n' }, lock: lock({ http: '1.5.0', lints: '6.0.0', meta: '1.17.0', async: '2.14.0' }) }
      },
    })
    expect(calls).toEqual([['upgrade', '--tighten']])
    expect(result).toEqual({
      unit,
      files: { pubspecs: { 'pubspec.yaml': 'name: changed\n' }, lock: lock({ http: '1.5.0', lints: '6.0.0', meta: '1.17.0', async: '2.14.0' }) },
      changes: {
        lints: { from: '5.0.0', to: '6.0.0', section: 'dev_dependencies' },
        meta: { from: '1.16.0', to: '1.17.0', section: 'dependencies' },
      },
      transitiveFixes: {},
      advisories: [],
    })
  })
  test('returns undefined when no direct dependency changes', async () => {
    const unit: Unit = { kind: 'minor', members: ['http'], targets: {} }
    const result = await applyUnit(unit, {
      base,
      deps,
      versioning: 'increase',
      fixes: new Map(),
      cutoff: new Date(),
      pub: async () => ({ pubspecs: base.pubspecs, lock: lock({ http: '1.5.0', lints: '5.0.0', meta: '1.16.0', async: '2.14.0' }) }),
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
    const baseWith = { pubspecs: { 'pubspec.yaml': 'name: app\ndependencies:\n  http: ^1.5.0\n' }, lock: lock({ http: '1.5.0', lints: '5.0.0', meta: '1.16.0', async: '2.13.0', path: '1.0.0' }) }
    const apply = (unit: Unit, versions: Record<string, string>) =>
      applyUnit(unit, {
        base: baseWith,
        deps,
        versioning: 'increase',
        pub: async () => ({ pubspecs: { 'pubspec.yaml': 'name: changed\n' }, lock: lock(versions) }),
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
