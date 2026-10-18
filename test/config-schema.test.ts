// pubreform.schema.json and config.ts must accept and reject the same configs.
import { describe, expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020'
import { parse } from 'yaml'
import schema from '../pubreform.schema.json'
import { validateConfig } from '../src/config.ts'

const ajv = new Ajv2020({ strict: true, allowMatchingProperties: true })
const validate = ajv.compile(schema)

// Values that only config.ts can check (cron semantics, time zone existence) are not listed here.
const examples: [name: string, yaml: string, valid: boolean][] = [
  ['minimal', 'schedule: {cron: "0 9 * * 1"}', true],
  [
    'full',
    `$schema: https://raw.githubusercontent.com/chika3742/pubreform/v1/pubreform.schema.json
schedule: {cron: "0 9 * * 1", timezone: Asia/Tokyo}
min_release_age_days: 3
labels: [dependencies, bot]
versioning: lockfile-only
ignore:
  - name: some_package
  - name: other_package
    versions: ">=3.0.0"
  - name: _private2
    versions: "^1.2.3-dev.1+4 <2.0.0"
  - name: any_pkg
    versions: any`,
    true,
  ],
  ['empty file', '', false],
  ['list', '- a', false],
  ['no schedule', 'labels: []', false],
  ['schedule is a string', 'schedule: "0 9 * * 1"', false],
  ['no cron', 'schedule: {timezone: UTC}', false],
  ['cron is a number', 'schedule: {cron: 5}', false],
  ['4 fields', 'schedule: {cron: "0 9 * *"}', false],
  ['6 fields', 'schedule: {cron: "0 0 9 * * 1"}', false],
  ['alias', 'schedule: {cron: "@weekly"}', false],
  ['surrounding spaces', 'schedule: {cron: " 0 9 * * 1 "}', true],
  ['empty time zone', 'schedule: {cron: "0 9 * * 1", timezone: ""}', false],
  ['unknown key in schedule', 'schedule: {cron: "0 9 * * 1", tz: UTC}', false],
  ['unknown top-level key', 'schedule: {cron: "0 9 * * 1"}\nlabel: [a]', false],
  ['$schema not a string', 'schedule: {cron: "0 9 * * 1"}\n$schema: 1', false],
  ['days 0', 'schedule: {cron: "0 9 * * 1"}\nmin_release_age_days: 0', true],
  ['days negative', 'schedule: {cron: "0 9 * * 1"}\nmin_release_age_days: -1', false],
  ['days fraction', 'schedule: {cron: "0 9 * * 1"}\nmin_release_age_days: 1.5', false],
  ['days 2.0', 'schedule: {cron: "0 9 * * 1"}\nmin_release_age_days: 2.0', true],
  ['days string', 'schedule: {cron: "0 9 * * 1"}\nmin_release_age_days: "3"', false],
  ['days null', 'schedule: {cron: "0 9 * * 1"}\nmin_release_age_days:', false],
  ['labels null', 'schedule: {cron: "0 9 * * 1"}\nlabels:', false],
  ['labels string', 'schedule: {cron: "0 9 * * 1"}\nlabels: deps', false],
  ['labels empty string', 'schedule: {cron: "0 9 * * 1"}\nlabels: [""]', false],
  ['labels duplicate', 'schedule: {cron: "0 9 * * 1"}\nlabels: [a, a]', false],
  ['labels number', 'schedule: {cron: "0 9 * * 1"}\nlabels: [1]', false],
  ['versioning increase', 'schedule: {cron: "0 9 * * 1"}\nversioning: increase', true],
  ['versioning unknown', 'schedule: {cron: "0 9 * * 1"}\nversioning: widen', false],
  ['ignore map', 'schedule: {cron: "0 9 * * 1"}\nignore: {name: a}', false],
  ['ignore string item', 'schedule: {cron: "0 9 * * 1"}\nignore: [a]', false],
  ['ignore no name', 'schedule: {cron: "0 9 * * 1"}\nignore: [{versions: ">=1.0.0"}]', false],
  ['ignore bad name', 'schedule: {cron: "0 9 * * 1"}\nignore: [{name: Foo}]', false],
  ['ignore name with dash', 'schedule: {cron: "0 9 * * 1"}\nignore: [{name: foo-bar}]', false],
  ['ignore unknown key', 'schedule: {cron: "0 9 * * 1"}\nignore: [{name: a, version: ">=1.0.0"}]', false],
  ['ignore versions null', 'schedule: {cron: "0 9 * * 1"}\nignore: [{name: a, versions: }]', false],
  ['ignore range', 'schedule: {cron: "0 9 * * 1"}\nignore: [{name: a, versions: ">=1.0.0 <2.0.0"}]', true],
  ['ignore exact', 'schedule: {cron: "0 9 * * 1"}\nignore: [{name: a, versions: "1.0.0"}]', true],
  ['ignore tilde', 'schedule: {cron: "0 9 * * 1"}\nignore: [{name: a, versions: "~1.0.0"}]', false],
  ['ignore short version', 'schedule: {cron: "0 9 * * 1"}\nignore: [{name: a, versions: ">=1.0"}]', false],
  ['ignore leading space', 'schedule: {cron: "0 9 * * 1"}\nignore: [{name: a, versions: " >=1.0.0"}]', false],
  ['ignore space after op', 'schedule: {cron: "0 9 * * 1"}\nignore: [{name: a, versions: ">= 1.0.0"}]', false],
  ['ignore any and more', 'schedule: {cron: "0 9 * * 1"}\nignore: [{name: a, versions: "any >=1.0.0"}]', false],
]

describe('schema and config.ts agree', () => {
  for (const [name, text, valid] of examples) {
    test(`${name}: ${valid ? 'valid' : 'invalid'}`, () => {
      const raw = parse(text)
      expect(validate(raw)).toBe(valid)
      let ok = true
      try {
        validateConfig(raw)
      } catch {
        ok = false
      }
      expect(ok).toBe(valid)
    })
  }
})
