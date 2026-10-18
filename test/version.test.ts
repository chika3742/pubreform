import { describe, expect, test } from 'bun:test'
import { allows, compareVersions, isStable, maxVersion, parseConstraint, parseVersion } from '../src/version.ts'

describe('parseVersion', () => {
  test('parses pre-release and build', () => {
    expect(parseVersion('1.2.3-dev.1+build.5')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      pre: ['dev', '1'],
      build: ['build', '5'],
    })
  })
  test('rejects invalid versions', () => {
    for (const s of ['1.2', '1.2.3.4', 'v1.2.3', '', '1.2.3-']) expect(() => parseVersion(s)).toThrow()
  })
  test('isStable', () => {
    expect(isStable('1.0.0')).toBe(true)
    expect(isStable('1.0.0+1')).toBe(true)
    expect(isStable('1.0.0-dev')).toBe(false)
  })
})

describe('compareVersions', () => {
  const ordered = [
    '0.9.9',
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.0+1',
    '1.0.0+2',
    '1.0.1',
    '1.2.0',
    '1.10.0',
    '2.0.0',
  ]
  test('orders versions', () => {
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        expect(Math.sign(compareVersions(ordered[i]!, ordered[j]!))).toBe(Math.sign(i - j))
      }
    }
  })
  test('maxVersion', () => {
    expect(maxVersion(['1.2.0', '1.10.0', '1.9.0'])).toBe('1.10.0')
    expect(maxVersion([])).toBeUndefined()
  })
})

describe('constraints', () => {
  const cases: [string, string, boolean][] = [
    ['any', '0.0.1', true],
    ['^1.2.3', '1.2.3', true],
    ['^1.2.3', '1.9.0', true],
    ['^1.2.3', '2.0.0', false],
    ['^1.2.3', '1.2.2', false],
    ['^0.3.1', '0.3.9', true],
    ['^0.3.1', '0.4.0', false],
    ['^0.0.1', '0.0.9', true],
    ['^0.0.1', '0.1.0', false],
    ['>=1.0.0', '9.0.0', true],
    ['>=1.0.0', '0.9.0', false],
    ['>1.0.0', '1.0.0', false],
    ['<=1.0.0', '1.0.0', true],
    ['<1.0.0', '1.0.0', false],
    ['1.0.0', '1.0.0', true],
    ['1.0.0', '1.0.1', false],
    ['>=1.0.0 <2.0.0', '1.5.0', true],
    ['>=1.0.0 <2.0.0', '2.0.0', false],
    ['>=1.0.0  <2.0.0', '1.5.0', true],
    ['>=3.0.0', '3.0.0', true],
    // Forms pub accepts in pubspec.yaml.
    ['>= 1.0.0', '1.0.0', true],
    ['^ 1.0.0', '2.0.0', false],
    ['>=1.0.0<2.0.0', '1.5.0', true],
    ['>=1.0.0<2.0.0', '2.0.0', false],
    [' >=1.0.0 <2.0.0 ', '2.0.0', false],
    ['< 2.0.0 >=1.3.0', '1.3.0', true],
    ['< 2.0.0 >=1.3.0', '1.2.0', false],
  ]
  for (const [c, v, expected] of cases) {
    test(`${c} ${expected ? 'allows' : 'rejects'} ${v}`, () => expect(allows(c, v)).toBe(expected))
  }
  test('rejects invalid constraints', () => {
    for (const s of ['', ' ', '^1.0', '>=1.0.0 any', 'latest', '=>1.0.0', '~1.0.0', '1.0.0.4', '1.2.3-', '>=', '1.0.0abc']) {
      expect(() => parseConstraint(s)).toThrow()
    }
  })
})
