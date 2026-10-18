import { describe, expect, test } from 'bun:test'
import { applyArgs, applyUnit } from '../src/applier.ts'
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
    expect(applyArgs(unit, deps, 'increase')).toEqual(['upgrade', '--tighten'])
    expect(applyArgs(unit, deps, 'lockfile-only')).toEqual(['upgrade'])
  })
  test('group with a dev dependency', () => {
    const unit: Unit = { kind: 'group', members: ['http', 'lints'], targets: { http: '2.0.0', lints: '6.0.0+1' } }
    expect(applyArgs(unit, deps, 'increase')).toEqual(['add', 'http:^2.0.0', 'dev:lints:^6.0.0+1'])
  })
  test('pinned versions stay pinned', () => {
    const pinned = deps.map((d) => (d.name === 'lints' ? { ...d, constraint: '5.0.0' } : d))
    const unit: Unit = { kind: 'group', members: ['http', 'lints'], targets: { http: '2.0.0', lints: '6.0.0' } }
    expect(applyArgs(unit, pinned, 'increase')).toEqual(['add', 'http:^2.0.0', 'dev:lints:6.0.0'])
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
    })
  })
  test('returns undefined when no direct dependency changes', async () => {
    const unit: Unit = { kind: 'minor', members: ['http'], targets: {} }
    const result = await applyUnit(unit, {
      base,
      deps,
      versioning: 'increase',
      pub: async () => ({ pubspec: base.pubspec, lock: lock({ http: '1.5.0', lints: '5.0.0', meta: '1.16.0', async: '2.14.0' }) }),
    })
    expect(result).toBeUndefined()
  })
})
