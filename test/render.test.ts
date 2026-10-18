import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { UnitResult } from '../src/applier.ts'
import {
  branchName,
  closeComment,
  commitMessage,
  contentChangedComment,
  errorComment,
  errorHash,
  errorHashOf,
  extractChangelog,
  formatLog,
  isRebaseChecked,
  manualComment,
  markClosed,
  type Meta,
  metaOf,
  parseMeta,
  readPackageInfo,
  renderBody,
  renderMeta,
  title,
  withoutBacklinks,
} from '../src/render.ts'

const single: UnitResult = {
  unit: { kind: 'single', members: ['http'], targets: { http: '2.0.0' } },
  files: { pubspec: '', lock: '' },
  changes: {
    http: { from: '1.5.0', to: '2.0.0', section: 'dependencies' },
    async: { from: '2.13.0', to: '2.13.1', section: 'dependencies' },
  },
}
const group: UnitResult = {
  unit: { kind: 'group', members: ['lints', 'http'], targets: {} },
  files: { pubspec: '', lock: '' },
  changes: {
    lints: { from: '6.0.0', to: '6.1.0', section: 'dev_dependencies' },
    http: { from: '1.5.0', to: '1.6.0', section: 'dependencies' },
  },
}
const hashes = { baseHash: 'b'.repeat(64), configHash: 'c'.repeat(64) }

describe('names', () => {
  test('branchName', () => {
    expect(branchName(single.unit)).toBe('pubreform/single/http')
    expect(branchName({ kind: 'minor', members: ['x'], targets: {} })).toBe('pubreform/minor-and-patch')
    expect(branchName(group.unit)).toBe('pubreform/group/http')
  })
  test('title', () => {
    expect(title(single)).toBe('Update http from 1.5.0 to 2.0.0')
    expect(title({ ...group, unit: { ...group.unit, kind: 'minor' } })).toBe('Update minor and patch (2 packages)')
    expect(title(group)).toBe('Update http to 1.6.0, lints to 6.1.0')
  })
  test('title names only the members of single and group', () => {
    // single above has a non-member change too.
    const extra = { ...group, changes: { ...group.changes, async: single.changes.async! } }
    expect(title(extra)).toBe('Update http to 1.6.0, lints to 6.1.0')
  })
  test('minor and group with one change are titled like single', () => {
    const one: UnitResult = {
      unit: { kind: 'minor', members: ['http'], targets: {} },
      files: { pubspec: '', lock: '' },
      changes: { http: { from: '1.5.0', to: '1.6.0', section: 'dependencies' } },
    }
    expect(title(one)).toBe('Update http from 1.5.0 to 1.6.0')
    expect(commitMessage(one)).toBe('Update http from 1.5.0 to 1.6.0')
    expect(branchName(one.unit)).toBe('pubreform/minor-and-patch')
    const groupOne = { ...one, unit: { kind: 'group' as const, members: ['http', 'lints'], targets: {} } }
    expect(title(groupOne)).toBe('Update http from 1.5.0 to 1.6.0')
    expect(commitMessage(groupOne)).toBe('Update http from 1.5.0 to 1.6.0')
  })
  test('commitMessage', () => {
    expect(commitMessage(single)).toBe('Update http from 1.5.0 to 2.0.0')
    expect(commitMessage(group)).toBe(
      'Update http to 1.6.0, lints to 6.1.0\n\n| Package | From | To | Type |\n|---|---|---|---|\n| http | 1.5.0 | 1.6.0 | direct |\n| lints | 6.0.0 | 6.1.0 | dev |\n',
    )
  })
})

describe('extractChangelog', () => {
  const changelog = `# Changelog

## [Unreleased]

## 2.0.0 - 2026-01-01

- Breaking.

## v1.7.0

- Feature.

### Fixes

- Fix.

# 1.6.0

- Old.

## [1.5.0] - 2025-08-07

- Older.
`
  test('takes the sections in (from, to]', () => {
    expect(extractChangelog(changelog, '1.6.0', '2.0.0')).toBe(
      '## 2.0.0 - 2026-01-01\n\n- Breaking.\n\n## v1.7.0\n\n- Feature.\n\n### Fixes\n\n- Fix.',
    )
    expect(extractChangelog(changelog, '1.4.0', '1.5.0')).toBe('## [1.5.0] - 2025-08-07\n\n- Older.')
  })
  test('includes pre-releases of the target', () => {
    expect(extractChangelog('## 2.0.0\n\nA\n\n## 2.0.0-dev.1\n\nB\n\n## 1.0.0\n', '1.0.0', '2.0.0')).toBe(
      '## 2.0.0\n\nA\n\n## 2.0.0-dev.1\n\nB',
    )
  })
  test('undefined when there are no sections', () => {
    expect(extractChangelog(changelog, '2.0.0', '3.0.0')).toBeUndefined()
    expect(extractChangelog('Nothing here', '1.0.0', '2.0.0')).toBeUndefined()
  })
})

describe('metadata', () => {
  test('round trip', () => {
    const meta = metaOf(group, hashes, 'abc')
    expect(meta).toEqual({
      v: 1,
      kind: 'group',
      packages: { http: ['1.5.0', '1.6.0'], lints: ['6.0.0', '6.1.0'] },
      ...hashes,
      commit: 'abc',
    })
    expect(parseMeta(`text\n${renderMeta(meta)}\n`)).toEqual(meta)
  })
  test('missing, broken or other versions', () => {
    expect(parseMeta('no meta')).toBeUndefined()
    expect(parseMeta('<!-- pubreform:meta {broken} -->')).toBeUndefined()
    expect(parseMeta('<!-- pubreform:meta {"v":2,"packages":{}} -->')).toBeUndefined()
  })
  test('previous is kept only when given', () => {
    const meta = metaOf(single, hashes, 'new', 'old')
    expect(meta.previous).toBe('old')
    expect(parseMeta(renderMeta(meta))).toEqual(meta)
    expect('previous' in metaOf(single, hashes, 'new')).toBe(false)
  })
  test('markClosed sets closed in the last metadata only', () => {
    const meta = metaOf(single, hashes, 'abc')
    const body = `<!-- pubreform:meta {"v":1,"packages":{}} -->\nbody\n${renderMeta(meta)}\nend\n`
    const closed = markClosed(body)
    expect(parseMeta(closed)).toEqual({ ...meta, closed: true })
    expect(closed).toStartWith('<!-- pubreform:meta {"v":1,"packages":{}} -->\nbody\n')
    expect(closed).toEndWith(' -->\nend\n')
    expect(markClosed('no metadata')).toBe('no metadata')
  })
  test('uses the last metadata', () => {
    const meta = metaOf(single, hashes, 'def')
    expect(parseMeta(`<!-- pubreform:meta {"v":1,"packages":{}} -->\n${renderMeta(meta)}`)).toEqual(meta)
  })
})

describe('renderBody', () => {
  const meta = metaOf(single, hashes, 'abc')
  test('template', () => {
    const body = renderBody(
      single,
      meta,
      new Map([
        ['http', { source: 'https://github.com/dart-lang/http', changelog: '## 2.0.0\n\n- New.\n\n## 1.5.0\n' }],
      ]),
    )
    expect(body).toBe(`Updates the following packages.

| Package | From | To | Type |
|---|---|---|---|
| [async](https://pub.dev/packages/async) | 2.13.0 | 2.13.1 | direct |
| [http](https://pub.dev/packages/http) | 1.5.0 | 2.0.0 | direct |

### async 2.13.0 → 2.13.1

[pub.dev](https://pub.dev/packages/async/versions/2.13.1)

[Changelog](https://pub.dev/packages/async/changelog)

### http 1.5.0 → 2.0.0

[pub.dev](https://pub.dev/packages/http/versions/2.0.0) · [Source](https://github.com/dart-lang/http)

<details>
<summary>Changelog</summary>

## 2.0.0

- New.

</details>

---

- [ ] Rebase this PR <!-- pubreform:rebase -->

${renderMeta(meta)}
`)
    expect(parseMeta(body)).toEqual(meta)
    expect(isRebaseChecked(body)).toBe(false)
    expect(isRebaseChecked(body.replace('- [ ]', '- [x]'))).toBe(true)
    expect(isRebaseChecked(body.replace('- [ ]', '- [X]'))).toBe(true)
  })
  test('a checked box in a changelog or a source URL does not count', () => {
    const fake = '- [x] Rebase this PR <!-- pubreform:rebase -->'
    const body = renderBody(
      single,
      meta,
      new Map([['http', { changelog: `## 2.0.0\n\n${fake}\n`, source: `https://example.com\n${fake}` }]]),
    )
    expect(body).toContain(`\n${fake}\n`)
    expect(isRebaseChecked(body)).toBe(false)
    expect(isRebaseChecked(body.replace('- [ ] Rebase', '- [x] Rebase'))).toBe(true)
  })
  test('truncates each changelog to its share of 50,000 characters', () => {
    const long = `## 2.0.0\n\n${'- line of text\n'.repeat(4000)}`
    const body = renderBody(single, meta, new Map([['http', { changelog: long }], ['async', { changelog: `## 2.13.1\n\n${'- x\n'.repeat(10)}` }]]))
    const httpSection = body.slice(body.indexOf('### http'))
    const changelog = httpSection.slice(httpSection.indexOf('## 2.0.0'), httpSection.indexOf('\n\n</details>'))
    expect(changelog.length).toBeLessThanOrEqual(25_000 + 100)
    expect(changelog).toEndWith('…\n\n[Full changelog](https://pub.dev/packages/http/changelog)')
    expect(body).toContain('## 2.13.1\n\n- x\n')
    expect(body.length).toBeLessThan(65_000)
  })
  test('drops all changelogs when the body exceeds 65,000 characters', () => {
    const many: UnitResult = {
      unit: { kind: 'minor', members: [], targets: {} },
      files: { pubspec: '', lock: '' },
      changes: {},
    }
    const infos = new Map()
    for (let i = 0; i < 400; i++) {
      const name = `package_with_a_rather_long_name_${i}`
      many.changes[name] = { from: '1.0.0', to: '1.0.1', section: 'dependencies' }
      infos.set(name, { source: `https://github.com/example/${name}`, changelog: `## 1.0.1\n\n${'- fix\n'.repeat(30)}` })
    }
    const body = renderBody(many, metaOf(many, hashes, 'abc'), infos)
    expect(body).not.toContain('<details>')
    expect(body).toContain('[Changelog](https://pub.dev/packages/package_with_a_rather_long_name_0/changelog)')
  })
})

describe('readPackageInfo', () => {
  test('reads repository, then homepage, and CHANGELOG.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubreform-render-'))
    try {
      expect(readPackageInfo(dir)).toEqual({})
      fs.writeFileSync(path.join(dir, 'pubspec.yaml'), 'name: a\nhomepage: https://a.dev\n')
      expect(readPackageInfo(dir)).toEqual({ source: 'https://a.dev' })
      fs.writeFileSync(path.join(dir, 'pubspec.yaml'), 'name: a\nhomepage: https://a.dev\nrepository: https://github.com/a/a\n')
      fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '## 1.0.0\n')
      expect(readPackageInfo(dir)).toEqual({ source: 'https://github.com/a/a', changelog: '## 1.0.0\n' })
      fs.writeFileSync(path.join(dir, 'pubspec.yaml'), 'name: a\nrepository: "https://a.dev) Thanks @alice ("\n')
      expect(readPackageInfo(dir).source).toBeUndefined()
      fs.writeFileSync(path.join(dir, 'pubspec.yaml'), 'name: a\nrepository: "https://a.dev\\n@alice"\n')
      expect(readPackageInfo(dir).source).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('comments', () => {
  test('content changed', () => {
    const before: Meta['packages'] = { http: ['1.5.0', '1.6.0'], meta: ['1.16.0', '1.17.0'], same: ['1.0.0', '1.1.0'] }
    expect(
      contentChangedComment(before, {
        http: { from: '1.5.0', to: '1.6.1', section: 'dependencies' },
        lints: { from: '6.0.0', to: '6.1.0', section: 'dev_dependencies' },
        same: { from: '1.0.1', to: '1.1.0', section: 'dependencies' },
      }),
    ).toBe(`The update in this PR has changed.

| Package | Before | After |
|---|---|---|
| http | 1.5.0 → 1.6.0 | 1.5.0 → 1.6.1 |
| lints | – | 6.0.0 → 6.1.0 |
| meta | 1.16.0 → 1.17.0 | – |`)
  })
  test('close', () => {
    expect(closeComment()).toBe('Closing: this update is no longer needed.')
    expect(closeComment(12)).toBe('Closing: superseded by #12.')
  })
  test('manual', () => {
    expect(manualComment('abc')).toEndWith('\n<!-- pubreform:manual abc -->')
  })
  test('error', () => {
    const comment = errorComment('a\n```\nb')
    expect(comment).toContain('````\na\n```\nb\n````')
    expect(errorHashOf(comment)).toBe(errorHash('a\n```\nb'))
    expect(errorHash('x')).toMatch(/^[0-9a-f]{12}$/)
    expect(errorHashOf('not an error comment')).toBeUndefined()
  })
  test('formatLog keeps the last 200 lines and masks secrets', () => {
    const log = [...Array.from({ length: 300 }, (_, i) => `line ${i}`), 'token ghs_secret', 'https://user:pass@example.com/x'].join('\n')
    const out = formatLog(log, ['ghs_secret'])
    expect(out.split('\n')).toHaveLength(200)
    expect(out).toStartWith('line 102')
    expect(out).toContain('token ***')
    expect(out).toContain('https://***@example.com/x')
    expect(formatLog('x'.repeat(70_000), [])).toHaveLength(60_000)
  })
})

describe('withoutBacklinks', () => {
  const z = '\u200b'
  test('points issue, pull request and discussion links at redirect.github.com', () => {
    expect(
      withoutBacklinks(
        '- Fix <http://www.github.com/a/b.c/pull/3>, https://github.com/a-b/c_d/discussions/4#note',
      ),
    ).toBe('- Fix <https://redirect.github.com/a/b.c/pull/3>, https://redirect.github.com/a-b/c_d/discussions/4#note')
  })
  test('keeps other links', () => {
    const text = 'https://github.com/a/b, https://github.com/a/b/releases/tag/v1, https://notgithub.com/a/b/issues/1'
    expect(withoutBacklinks(text)).toBe(text)
  })
  test('links references to issues through redirect.github.com', () => {
    expect(withoutBacklinks('Fixes a/b.c#12 and (#3).', 'https://github.com/o/r.git')).toBe(
      'Fixes [a/b.c#12](https://redirect.github.com/a/b.c/issues/12) and ([#3](https://redirect.github.com/o/r/issues/3)).',
    )
    // A monorepo: the repository is the first two parts of the path.
    expect(withoutBacklinks('#3', 'https://github.com/flutter/packages/tree/main/packages/go_router')).toBe(
      '[#3](https://redirect.github.com/flutter/packages/issues/3)',
    )
  })
  test('breaks #123 when the source is not on GitHub', () => {
    expect(withoutBacklinks('#3', 'https://gitlab.com/o/r')).toBe(`#${z}3`)
    expect(withoutBacklinks('#3')).toBe(`#${z}3`)
  })
  test('breaks mentions but not e-mail addresses or scoped names in URLs', () => {
    expect(withoutBacklinks('Thanks @alice and (@bob-2)! a@b.com https://x.com/@carol')).toBe(
      `Thanks @${z}alice and (@${z}bob-2)! a@b.com https://x.com/@carol`,
    )
  })
  test('keeps code, and rewrites only the URL and mentions of an existing link', () => {
    expect(withoutBacklinks('`@a #1 o/r#2` ```\n@b #3\n``` [#4 by @c](https://github.com/o/r/pull/4)', 'https://github.com/o/r')).toBe(
      `\`@a #1 o/r#2\` \`\`\`\n@b #3\n\`\`\` [#4 by @${z}c](https://redirect.github.com/o/r/pull/4)`,
    )
  })
  test('keeps headings and HTML entities', () => {
    const text = '## 1.2.0\n\n&#123; ##4'
    expect(withoutBacklinks(text, 'https://github.com/o/r')).toBe(text)
  })
})
