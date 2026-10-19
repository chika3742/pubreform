import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RUN_USER, commandEnv, isInside, parseStatus, sudoArgs, treeEntries } from '../src/generate.ts'

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
    INPUT_TOKEN: 'secret',
    ACTIONS_RUNTIME_TOKEN: 'secret',
    GITHUB_TOKEN: 'secret',
    API_SPEC_URL: 'https://example.com/spec',
  }
  test('passes only the listed variables that are set', () => {
    expect(commandEnv(source, { home: '/tmp/h', pubCache: '/cache', extra: [] })).toEqual({
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      CI: 'true',
      HOME: '/tmp/h',
      PUB_CACHE: '/cache',
    })
  })
  test('adds the names in env, but not over HOME and PUB_CACHE', () => {
    expect(
      commandEnv(source, { home: '/tmp/h', pubCache: '/cache', extra: ['API_SPEC_URL', 'MISSING', 'HOME', 'PUB_CACHE'] }),
    ).toEqual({
      API_SPEC_URL: 'https://example.com/spec',
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      CI: 'true',
      HOME: '/tmp/h',
      PUB_CACHE: '/cache',
    })
  })
})

describe('sudoArgs', () => {
  const env = { PATH: '/usr/bin', HOME: '/tmp/h' }
  test('without the network', () => {
    expect(sudoArgs({ run: 'dart run build_runner build', network: false, env: [] }, env)).toEqual([
      '-n',
      'unshare',
      '--net',
      '--',
      'runuser',
      '-u',
      RUN_USER,
      '--',
      'env',
      '-i',
      'PATH=/usr/bin',
      'HOME=/tmp/h',
      'sh',
      '-c',
      'dart run build_runner build',
    ])
  })
  test('with the network', () => {
    expect(sudoArgs({ run: './gen.sh', network: true, env: [] }, env)).toEqual([
      '-n',
      'runuser',
      '-u',
      RUN_USER,
      '--',
      'env',
      '-i',
      'PATH=/usr/bin',
      'HOME=/tmp/h',
      'sh',
      '-c',
      './gen.sh',
    ])
  })
})
