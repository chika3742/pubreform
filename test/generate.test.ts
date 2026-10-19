import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commandEnv, dockerArgs, isInside, parseStatus, treeEntries } from '../src/generate.ts'

describe('parseStatus', () => {
  test('modified, deleted, type changed and untracked', () => {
    const output = [' M lib/a.g.dart', ' D old.g.dart', ' T link', '?? lib/new file.g.dart', '?? nested/', ''].join('\0')
    expect(parseStatus(output)).toEqual([
      { path: 'lib/a.g.dart', deleted: false },
      { path: 'old.g.dart', deleted: true },
      { path: 'link', deleted: false },
      { path: 'lib/new file.g.dart', deleted: false },
      { path: 'nested/', deleted: false },
    ])
  })
  test('empty', () => {
    expect(parseStatus('')).toEqual([])
  })
})

describe('isInside', () => {
  test.each([
    ['lib/a.dart', true],
    ['.github/x', true],
    ['a..b', true],
    ['../a', false],
    ['lib/../../a', false],
    ['/etc/passwd', false],
    ['lib//a', false],
    ['./a', false],
    ['nested/', false],
    ['', false],
  ])('%s: %p', (p, inside) => {
    expect(isInside(p)).toBe(inside)
  })
})

describe('treeEntries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubreform-tree-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pubreform-outside-'))
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(outside, 'secret'), 'secret\n')
  fs.mkdirSync(path.join(dir, 'lib'))
  fs.writeFileSync(path.join(dir, 'lib/a.g.dart'), '﻿part of a;\r\n')
  fs.writeFileSync(path.join(dir, 'tool.sh'), '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
  fs.writeFileSync(path.join(dir, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]))
  fs.symlinkSync(path.join(outside, 'secret'), path.join(dir, 'link'))
  fs.symlinkSync(outside, path.join(dir, 'linked-dir'))
  fs.mkdirSync(path.join(dir, 'nested'))
  fs.writeFileSync(path.join(dir, 'pubspec.yaml'), 'changed')
  fs.writeFileSync(path.join(dir, 'pubspec.lock'), 'changed')

  test('reads each kind of change', () => {
    const changes = [
      'lib/a.g.dart',
      'tool.sh',
      'image.png',
      'latin1.txt',
      'link',
      'linked-dir/secret',
      'nested/',
      'nested',
      '../secret',
      'pubspec.yaml',
      'pubspec.lock',
      'vanished.txt',
    ].map((p) => ({ path: p, deleted: false }))
    changes.push({ path: 'old.g.dart', deleted: true }, { path: '../x', deleted: true })
    expect(treeEntries(dir, changes)).toEqual([
      // The BOM and CRLF are kept.
      { path: 'lib/a.g.dart', mode: '100644', content: '﻿part of a;\r\n' },
      { path: 'tool.sh', mode: '100755', content: '#!/bin/sh\n' },
      { path: 'image.png', mode: '100644', base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]).toString('base64') },
      { path: 'latin1.txt', mode: '100644', base64: Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64') },
      // A link is committed as a link, not as the file that it points to.
      { path: 'link', mode: '120000', content: path.join(outside, 'secret') },
      { path: 'old.g.dart', deleted: true },
    ])
  })
})

describe('commandEnv', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/runner',
    PUB_CACHE: '/home/runner/.pub-cache',
    LANG: 'C.UTF-8',
    CI: 'true',
    FLUTTER_ROOT: '/somewhere/flutter',
    INPUT_TOKEN: 'secret',
    ACTIONS_RUNTIME_TOKEN: 'secret',
    GITHUB_TOKEN: 'secret',
    API_SPEC_URL: 'https://example.com/spec',
  }
  const dart = { root: '/opt/dart-sdk', flutter: false }
  const flutter = { root: '/opt/flutter', flutter: true }

  test('passes only the listed variables that are set, without HOME', () => {
    expect(commandEnv(source, { sdk: dart, pubCache: '/cache', extra: [] })).toEqual({
      LANG: 'C.UTF-8',
      CI: 'true',
      PATH: '/usr/bin',
      PUB_CACHE: '/cache',
    })
  })
  test('a Flutter SDK puts its bundled Dart first and sets FLUTTER_ROOT', () => {
    expect(commandEnv(source, { sdk: flutter, pubCache: '/cache', extra: [] })).toEqual({
      LANG: 'C.UTF-8',
      CI: 'true',
      PATH: '/opt/flutter/bin/cache/dart-sdk/bin:/usr/bin',
      FLUTTER_ROOT: '/opt/flutter',
      PUB_CACHE: '/cache',
    })
  })
  test('adds the names in env, but not over the defaults', () => {
    const extra = ['API_SPEC_URL', 'MISSING', 'HOME', 'PUB_CACHE', 'PATH', 'FLUTTER_ROOT']
    expect(commandEnv({ ...source, PATH: '/usr/bin' }, { sdk: dart, pubCache: '/cache', extra })).toEqual({
      API_SPEC_URL: 'https://example.com/spec',
      LANG: 'C.UTF-8',
      CI: 'true',
      PATH: '/usr/bin',
      PUB_CACHE: '/cache',
    })
    expect(commandEnv(source, { sdk: flutter, pubCache: '/cache', extra })).toMatchObject({
      PATH: '/opt/flutter/bin/cache/dart-sdk/bin:/usr/bin',
      FLUTTER_ROOT: '/opt/flutter',
    })
  })
})

describe('dockerArgs', () => {
  const opts = {
    name: 'pubreform-abc',
    image: 'pubreform-run:abc',
    uid: 1001,
    gid: 118,
    sdk: '/opt/dart-sdk',
    pubCache: '/home/runner/.pub-cache',
    dir: '/tmp/pubreform-gen-x',
    envNames: ['PATH', 'PUB_CACHE', 'API_TOKEN'],
  }
  const common = (network: string[]) => [
    'run',
    '--rm',
    '--name',
    'pubreform-abc',
    '--user',
    '1001:118',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    ...network,
    '-v',
    '/usr:/usr:ro',
    '-v',
    '/opt/dart-sdk:/opt/dart-sdk:ro',
    '-v',
    '/home/runner/.pub-cache:/home/runner/.pub-cache:ro',
    '-v',
    '/tmp/pubreform-gen-x:/tmp/pubreform-gen-x',
    '-w',
    '/tmp/pubreform-gen-x',
    '-e',
    'HOME=/tmp',
    '-e',
    'PATH',
    '-e',
    'PUB_CACHE',
    '-e',
    'API_TOKEN',
    'pubreform-run:abc',
    'sh',
    '-c',
  ]
  test('without the network; values of the variables are not on the command line', () => {
    expect(dockerArgs({ run: 'dart run build_runner build', network: false, env: [] }, opts)).toEqual([
      ...common(['--network', 'none']),
      'dart run build_runner build',
    ])
  })
  test('with the network', () => {
    expect(dockerArgs({ run: './gen.sh', network: true, env: [] }, opts)).toEqual([...common([]), './gen.sh'])
  })
})
