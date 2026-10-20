import { describe, expect, test } from 'bun:test'
import { plan } from '../src/planner.ts'
import type { DirectDep } from '../src/pubspec.ts'
import { type Universe, fakeResolve } from './fake-pub.ts'

const universe: Universe = {
  // a 1.5.0 needs b 3: a 1.2→1.4 is minor, 1.4→1.5 goes into a group with b.
  a: { '1.2.0': {}, '1.4.0': {}, '1.5.0': { b: '>=3.0.0' } },
  b: { '2.0.0': {}, '3.0.0': {} },
  // c: an independent major update. 3.0.0 needs a package that does not exist.
  c: { '1.0.0': {}, '2.0.0': {}, '3.0.0': { nope: 'any' } },
  // d: minor only.
  d: { '1.0.0': {}, '1.1.0': {} },
  // e and f need each other.
  e: { '0.1.0': {}, '0.2.0': { f: '>=2.0.0' } },
  f: { '1.0.0': {}, '2.0.0': { e: '>=0.2.0' } },
}

const deps: DirectDep[] = [
  { name: 'a', section: 'dependencies', constraint: '^1.2.0', current: '1.2.0' },
  { name: 'b', section: 'dependencies', constraint: '^2.0.0', current: '2.0.0' },
  { name: 'c', section: 'dependencies', constraint: '^1.0.0', current: '1.0.0' },
  { name: 'd', section: 'dependencies', constraint: '^1.0.0', current: '1.0.0' },
  { name: 'e', section: 'dev_dependencies', constraint: '^0.1.0', current: '0.1.0' },
  { name: 'f', section: 'dev_dependencies', constraint: '^1.0.0', current: '1.0.0' },
]

const basePubspec = `name: app
dependencies:
  a: ^1.2.0
  b: ^2.0.0
  c: ^1.0.0
  d: ^1.0.0
dev_dependencies:
  e: ^0.1.0
  f: ^1.0.0
`
const locked = new Map(deps.map((d) => [d.name, d.current]))
const fixes = new Map()
const visibleVersions = async (name: string) => Object.keys(universe[name]!)

describe('plan', () => {
  test('splits updates into minor, single and group units', async () => {
    const result = await plan({ deps, basePubspec, resolve: fakeResolve(universe, locked), visibleVersions, fixes })
    expect(result.units).toEqual([
      { kind: 'minor', members: ['a', 'd'], targets: {} },
      { kind: 'group', members: ['a', 'b'], targets: { a: '1.5.0', b: '3.0.0' } },
      { kind: 'single', members: ['c'], targets: { c: '2.0.0' } },
      { kind: 'group', members: ['e', 'f'], targets: { e: '0.2.0', f: '2.0.0' } },
    ])
    expect(result.uncertain).toEqual(new Set())
    expect(result.unresolvable).toEqual([
      { name: 'c', section: 'dependencies', current: deps.find((d) => d.name === 'c')!.current, resolvable: '2.0.0', latest: '3.0.0' },
    ])
  })

  test('ignores pre-releases for unresolvable', async () => {
    const result = await plan({
      deps,
      basePubspec,
      resolve: fakeResolve(universe, locked),
      visibleVersions: async (name) => (name === 'd' ? ['1.0.0', '1.1.0', '2.0.0-dev.1'] : visibleVersions(name)),
      fixes,
    })
    expect(result.unresolvable.map((u) => u.name)).toEqual(['c'])
  })

  test('no units when everything is up to date', async () => {
    const result = await plan({
      deps: [{ name: 'd', section: 'dependencies', constraint: '^1.0.0', current: '1.1.0' }],
      basePubspec: 'name: app\ndependencies:\n  d: ^1.0.0\n',
      resolve: fakeResolve(universe, new Map([['d', '1.1.0']])),
      visibleVersions,
      fixes,
    })
    expect(result.units).toEqual([])
  })

  test('a failed closure makes the package uncertain', async () => {
    const resolve = fakeResolve(universe, locked)
    const logs: string[] = []
    const result = await plan({
      deps,
      basePubspec,
      resolve: async (args, pubspec) => {
        if (args[0] === 'get' && /\bc: 2\.0\.0/.test(pubspec)) throw new Error('network')
        return resolve(args, pubspec)
      },
      visibleVersions,
      fixes,
      log: (m) => logs.push(m),
    })
    expect(result.uncertain).toEqual(new Set(['c']))
    expect(result.units.map((u) => u.members.join())).toEqual(['a,d', 'a,b', 'e,f'])
    expect(logs).toEqual(['Failed to plan c: network'])
  })

  test('errors in U or R are thrown', async () => {
    const resolve = fakeResolve(universe, locked)
    await expect(
      plan({
        deps,
        basePubspec,
        resolve: async (args, pubspec) => {
          if (args[0] === 'upgrade' && pubspec.includes('>=')) throw new Error('R failed')
          return resolve(args, pubspec)
        },
        visibleVersions,
        fixes,
      }),
    ).rejects.toThrow('R failed')
  })

  test('sets that overlap after merging are merged again', async () => {
    // x needs y 2, z needs y 2 and w 2: S(x) = {x, y}, S(z) = {z, y, w} -> {w, x, y, z}.
    const u: Universe = {
      x: { '1.0.0': {}, '2.0.0': { y: '>=2.0.0' } },
      y: { '1.0.0': {}, '2.0.0': {} },
      z: { '1.0.0': {}, '2.0.0': { y: '>=2.0.0', w: '>=2.0.0' } },
      w: { '1.0.0': {}, '2.0.0': {} },
    }
    const ds: DirectDep[] = ['w', 'x', 'y', 'z'].map((name) => ({
      name,
      section: 'dependencies',
      constraint: '^1.0.0',
      current: '1.0.0',
    }))
    const result = await plan({
      deps: ds,
      basePubspec: 'name: app\ndependencies:\n  w: ^1.0.0\n  x: ^1.0.0\n  y: ^1.0.0\n  z: ^1.0.0\n',
      resolve: fakeResolve(u, new Map(ds.map((d) => [d.name, d.current]))),
      visibleVersions: async (name) => Object.keys(u[name]!),
      fixes,
    })
    expect(result.units).toEqual([
      {
        kind: 'group',
        members: ['w', 'x', 'y', 'z'],
        targets: { w: '2.0.0', x: '2.0.0', y: '2.0.0', z: '2.0.0' },
      },
    ])
  })

  test('a minor unit without members when only a fixed transitive dependency changes', async () => {
    // t is a transitive dependency of d: 1.0.0 is affected, 1.0.1 fixes it. pub upgrade moves t only.
    const ds: DirectDep[] = [{ name: 'd', section: 'dependencies', constraint: '^1.0.0', current: '1.0.0' }]
    const pubspec = 'name: app\ndependencies:\n  d: ^1.0.0\n'
    const resolve = async () => new Map([['d', '1.0.0'], ['t', '1.0.1']])
    const fix = (affected: string[]) =>
      new Map([['t', { name: 't', locked: '1.0.0', advisories: [], affected: new Set(affected), fix: { version: '1.0.1' } }]])
    const run = (fixes: Map<string, any>) =>
      plan({ deps: ds, basePubspec: pubspec, resolve, visibleVersions: async () => ['1.0.0'], fixes })
    expect((await run(fix(['1.0.0']))).units).toEqual([{ kind: 'minor', members: [], targets: {} }])
    // Not when U still has an affected version.
    expect((await run(fix(['1.0.0', '1.0.1']))).units).toEqual([])
    // Nor for transitive dependencies that need no fix.
    expect((await run(new Map())).units).toEqual([])
  })
})
