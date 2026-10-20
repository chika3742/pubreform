import { describe, expect, test } from 'bun:test'
import { type Advisory, collectFixes, findFix, parseAdvisories, validAdvisories } from '../src/advisories.ts'
import type { Listing } from '../src/proxy.ts'

const osv = (id: string, versions: string[], extra: Record<string, unknown> = {}) => ({
  id,
  affected: [{ package: { name: 'foo', ecosystem: 'Pub' }, versions }],
  ...extra,
})

describe('parseAdvisories', () => {
  test('reads the fields and the affected versions of the package', () => {
    const advisories = parseAdvisories(
      {
        advisories: [
          osv('GHSA-1', ['1.0.0'], {
            aliases: ['CVE-1'],
            summary: 'Path traversal',
            database_specific: { severity: 'HIGH', pub_display_url: 'https://github.com/advisories/GHSA-1' },
            affected: [
              { package: { name: 'foo', ecosystem: 'Pub' }, versions: ['1.0.0'] },
              { package: { name: 'foo', ecosystem: 'pub' }, versions: ['1.1.0'] },
              { package: { name: 'bar', ecosystem: 'Pub' }, versions: ['9.0.0'] },
              { package: { name: 'foo', ecosystem: 'npm' }, versions: ['8.0.0'] },
            ],
          }),
        ],
        advisoriesUpdated: '2026-10-19T00:00:00Z',
      },
      'foo',
    )
    expect(advisories).toEqual([
      {
        id: 'GHSA-1',
        aliases: ['CVE-1'],
        summary: 'Path traversal',
        severity: 'high',
        url: 'https://github.com/advisories/GHSA-1',
        versions: new Set(['1.0.0', '1.1.0']),
      },
    ])
  })
  test('drops withdrawn advisories and those without the package', () => {
    const body = {
      advisories: [
        osv('GHSA-w', ['1.0.0'], { withdrawn: '2026-01-01T00:00:00Z' }),
        { id: 'GHSA-other', affected: [{ package: { name: 'bar', ecosystem: 'Pub' }, versions: ['1.0.0'] }] },
        osv('GHSA-ok', ['1.0.0'], { aliases: 'not a list' }),
      ],
    }
    expect(parseAdvisories(body, 'foo')).toEqual([{ id: 'GHSA-ok', aliases: [], versions: new Set(['1.0.0']) }])
  })
  test('keeps only URLs that cannot leave the link', () => {
    const url = (u: unknown) => parseAdvisories({ advisories: [osv('A', [], { database_specific: { pub_display_url: u } })] }, 'foo')[0]!.url
    expect(url('https://github.com/advisories/A')).toBe('https://github.com/advisories/A')
    expect(url('https://example.com/a)b')).toBeUndefined()
    expect(url('javascript:alert(1)')).toBeUndefined()
    expect(url('https://example.com/a b')).toBeUndefined()
    expect(url(1)).toBeUndefined()
  })
  test('throws on an unexpected shape', () => {
    expect(() => parseAdvisories({}, 'foo')).toThrow('advisories is not a list')
    expect(() => parseAdvisories({ advisories: [{ affected: [] }] }, 'foo')).toThrow('no id')
    expect(() => parseAdvisories({ advisories: [{ id: 'A' }] }, 'foo')).toThrow('no affected list')
    expect(() => parseAdvisories({ advisories: [{ id: 'A', affected: [{ package: { name: 'foo' }, versions: [] }] }] }, 'foo')).toThrow(
      'without a name or an ecosystem',
    )
    expect(() =>
      parseAdvisories({ advisories: [{ id: 'A', affected: [{ package: { name: 'foo', ecosystem: 'Pub' }, versions: [1] }] }] }, 'foo'),
    ).toThrow('not a list of strings')
  })
})

const advisory = (id: string, versions: string[], aliases: string[] = []): Advisory => ({ id, aliases, versions: new Set(versions) })

describe('validAdvisories', () => {
  test('ignored_advisories matches the id or an alias', () => {
    const list = [advisory('A', []), advisory('B', [], ['CVE-B']), advisory('C', [], ['CVE-C'])]
    expect(validAdvisories(list, new Set(['A', 'CVE-C'])).map((a) => a.id)).toEqual(['B'])
  })
})

const listing = (versions: [string, string, boolean?][]): Listing => ({
  versions: versions.map(([version, published, retracted]) => ({ version, published, ...(retracted ? { retracted } : {}) })),
})

describe('findFix', () => {
  test('the oldest version that no advisory affects: a backport', () => {
    const l = listing([
      ['1.2.3', '2026-01-01T00:00:00Z'],
      ['1.3.0', '2026-02-01T00:00:00Z'],
      ['1.2.4', '2026-10-18T00:00:00Z'],
      ['1.3.1', '2026-10-18T00:00:00Z'],
    ])
    const a = advisory('B', ['1.2.3', '1.3.0'])
    expect(findFix('foo', '1.2.3', l, [advisory('A', ['0.1.0']), a], [])).toEqual({
      name: 'foo',
      locked: '1.2.3',
      advisories: [a],
      affected: new Set(['0.1.0', '1.2.3', '1.3.0']),
      fix: { version: '1.2.4', published: new Date('2026-10-18T00:00:00Z') },
    })
  })
  test('skips retracted versions and pre-releases', () => {
    const l = listing([
      ['1.0.0', '2026-01-01T00:00:00Z'],
      ['1.0.1-dev', '2026-01-02T00:00:00Z'],
      ['1.0.1', '2026-01-03T00:00:00Z', true],
      ['1.0.2', '2026-01-04T00:00:00Z'],
    ])
    expect(findFix('foo', '1.0.0', l, [advisory('A', ['1.0.0'])], [])?.fix?.version).toBe('1.0.2')
  })
  test('skips versions that ignore covers: the next oldest fix', () => {
    const l = listing([
      ['1.0.0', '2026-01-01T00:00:00Z'],
      ['1.0.1', '2026-01-02T00:00:00Z'],
      ['1.0.2', '2026-01-03T00:00:00Z'],
    ])
    const a = [advisory('A', ['1.0.0'])]
    expect(findFix('foo', '1.0.0', l, a, [{ name: 'foo', versions: '1.0.1' }])?.fix?.version).toBe('1.0.2')
    expect(findFix('foo', '1.0.0', l, a, [{ name: 'bar' }])?.fix?.version).toBe('1.0.1')
    expect(findFix('foo', '1.0.0', l, a, [{ name: 'foo' }])?.fix).toBeUndefined()
  })
  test('advisories in id order', () => {
    const l = listing([['1.0.0', '2026-01-01T00:00:00Z']])
    expect(findFix('foo', '1.0.0', l, [advisory('B', ['1.0.0']), advisory('A', ['1.0.0'])], [])!.advisories.map((a) => a.id)).toEqual(['A', 'B'])
  })
  test('undefined when the locked version is not affected', () => {
    expect(findFix('foo', '1.0.0', listing([['1.0.0', '2026-01-01T00:00:00Z']]), [advisory('A', ['0.9.0'])], [])).toBeUndefined()
  })
  test('no fixed version', () => {
    const l = listing([
      ['1.0.0', '2026-01-01T00:00:00Z'],
      ['1.1.0', '2026-01-02T00:00:00Z'],
      ['0.9.0', '2025-01-01T00:00:00Z'],
    ])
    const fix = findFix('foo', '1.0.0', l, [advisory('A', ['1.0.0', '1.1.0'])], [])!
    expect(fix.fix).toBeUndefined()
    expect(fix.advisories.map((a) => a.id)).toEqual(['A'])
  })
})

describe('collectFixes', () => {
  const entry = (name: string, version: string, url = 'https://pub.dev') =>
    `  ${name}:\n    dependency: transitive\n    description:\n      name: ${name}\n      sha256: "00"\n      url: "${url}"\n    source: hosted\n    version: "${version}"\n`
  const lock = `packages:\n${entry('foo', '1.0.0')}${entry('bar', '1.0.0')}${entry('other', '1.0.0', 'https://example.com')}  sdkdep:\n    dependency: "direct main"\n    description: flutter\n    source: sdk\n    version: "0.0.0"\n`
  const listings: Record<string, Listing> = {
    foo: { ...listing([['1.0.0', '2026-01-01T00:00:00Z'], ['1.0.1', '2026-01-02T00:00:00Z']]), advisoriesUpdated: '2026-10-19T00:00:00Z' },
    bar: listing([['1.0.0', '2026-01-01T00:00:00Z']]),
  }

  test('fetches advisories only for pub.dev packages with advisoriesUpdated', async () => {
    const requested: string[] = []
    const fixes = await collectFixes({
      pubspec: 'name: app\nignored_advisories: [GHSA-ignored]\n',
      lock,
      ignore: [{ name: 'foo', versions: '1.0.0' }],
      listing: async (name) => {
        requested.push(`listing ${name}`)
        return listings[name]!
      },
      advisories: async (name) => {
        requested.push(`advisories ${name}`)
        return { advisories: [osv('GHSA-1', ['1.0.0']), osv('GHSA-ignored', ['1.0.1'])] }
      },
    })
    expect(requested.sort()).toEqual(['advisories foo', 'listing bar', 'listing foo'])
    expect([...fixes.keys()]).toEqual(['foo'])
    expect(fixes.get('foo')!.fix?.version).toBe('1.0.1')
  })
  test('a failure to fetch is thrown', async () => {
    const opts = { pubspec: 'name: app\n', lock, advisories: async () => ({ advisories: [] }), ignore: [] }
    await expect(
      collectFixes({
        ...opts,
        listing: async (name) => {
          if (name === 'bar') throw new Error('cannot get the versions of bar: HTTP 500')
          return listings[name]!
        },
      }),
    ).rejects.toThrow('HTTP 500')
    await expect(
      collectFixes({
        ...opts,
        listing: async (name) => listings[name]!,
        advisories: async () => {
          throw new Error('timeout')
        },
      }),
    ).rejects.toThrow('timeout')
  })
})
