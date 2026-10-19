import { describe, expect, test } from 'bun:test'
import { ConfigError, configHash, parseConfig } from '../src/config.ts'

describe('parseConfig', () => {
  test('fills in defaults', () => {
    expect(parseConfig('schedule:\n  cron: "0 9 * * 1"\n')).toEqual({
      schedule: { cron: '0 9 * * 1', timezone: 'UTC' },
      min_release_age_days: 0,
      labels: [],
      versioning: 'increase',
      ignore: [],
      post_update: [],
    })
  })

  test('reads all keys', () => {
    const config = parseConfig(`
# $schema: https://raw.githubusercontent.com/chika3742/pubreform/v1/pubreform.schema.json
schedule:
  cron: "0 9 * * 1"
  timezone: Asia/Tokyo
min_release_age_days: 3
labels: [dependencies]
versioning: lockfile-only
ignore:
  - name: some_package
  - name: other_package
    versions: ">=3.0.0"
post_update:
  - run: dart run build_runner build
  - run: ./tool/generate_api.sh
    network: true
    env: [API_SPEC_URL]
`)
    expect(config).toEqual({
      schedule: { cron: '0 9 * * 1', timezone: 'Asia/Tokyo' },
      min_release_age_days: 3,
      labels: ['dependencies'],
      versioning: 'lockfile-only',
      ignore: [{ name: 'some_package' }, { name: 'other_package', versions: '>=3.0.0' }],
      post_update: [
        { run: 'dart run build_runner build', network: false, env: [] },
        { run: './tool/generate_api.sh', network: true, env: ['API_SPEC_URL'] },
      ],
    })
  })

  const errors: [string, string][] = [
    ['', 'the config must be a map'],
    ['schedule: [', 'not valid YAML'],
    ['labels: []', 'schedule: is required'],
    ['schedule: {}', 'schedule.cron: is required'],
    ['schedule: {cron: "0 9 * *"}', 'schedule.cron: must have 5 fields'],
    ['schedule: {cron: "0 0 9 * * 1"}', 'schedule.cron: must have 5 fields'],
    ['schedule: {cron: "@daily"}', 'schedule.cron: must have 5 fields'],
    ['schedule: {cron: "0 25 * * 1"}', 'schedule.cron: invalid cron expression'],
    ['schedule: {cron: "0 9 * * 1", timezone: Asia/Tokio}', 'schedule.timezone: unknown time zone "Asia/Tokio"'],
    ['schedule: {cron: "0 9 * * 1", tz: UTC}', 'schedule.tz: unknown key'],
    ['schedule: {cron: "0 9 * * 1"}\nmin_release_age_days: -1', 'min_release_age_days: must be an integer'],
    ['schedule: {cron: "0 9 * * 1"}\nmin_release_age_days: 1.5', 'min_release_age_days: must be an integer'],
    ['schedule: {cron: "0 9 * * 1"}\nlabels: [a, a]', 'labels[1]: duplicate label "a"'],
    ['schedule: {cron: "0 9 * * 1"}\nlabels: [""]', 'labels[0]: must not be empty'],
    ['schedule: {cron: "0 9 * * 1"}\nlabels:', 'labels: must be a list'],
    ['schedule: {cron: "0 9 * * 1"}\nversioning: widen', 'versioning: must be'],
    ['schedule: {cron: "0 9 * * 1"}\nignore: [{versions: "^1.0.0"}]', 'ignore[0].name: is required'],
    ['schedule: {cron: "0 9 * * 1"}\nignore: [{name: Foo}]', 'ignore[0].name: invalid package name'],
    ['schedule: {cron: "0 9 * * 1"}\nignore: [{name: foo, versions: "~1.0.0"}]', 'ignore[0].versions: invalid version constraint'],
    ['schedule: {cron: "0 9 * * 1"}\nignroe: []', 'ignroe: unknown key'],
    ['schedule: {cron: "0 9 * * 1"}\n$schema: 1', '$schema: must be a string'],
    ['schedule: {cron: "0 9 * * 1"}\npost_update: {run: a}', 'post_update: must be a list'],
    ['schedule: {cron: "0 9 * * 1"}\npost_update: [{network: true}]', 'post_update[0].run: is required'],
    ['schedule: {cron: "0 9 * * 1"}\npost_update: [{run: ""}]', 'post_update[0].run: must not be empty'],
    ['schedule: {cron: "0 9 * * 1"}\npost_update: [{run: a, network: yes please}]', 'post_update[0].network: must be true or false'],
    ['schedule: {cron: "0 9 * * 1"}\npost_update: [{run: a, env: [A-B]}]', 'post_update[0].env[0]: invalid environment variable name'],
    ['schedule: {cron: "0 9 * * 1"}\npost_update: [{run: a, env: [A, A]}]', 'post_update[0].env[1]: duplicate name "A"'],
    ['schedule: {cron: "0 9 * * 1"}\npost_update: [{run: a, env: [INPUT_TOKEN]}]', 'post_update[0].env[0]: "INPUT_TOKEN" must not be passed'],
    ['schedule: {cron: "0 9 * * 1"}\npost_update: [{run: a, env: [ACTIONS_ID_TOKEN_REQUEST_TOKEN]}]', 'post_update[0].env[0]: "ACTIONS_ID_TOKEN_REQUEST_TOKEN" must not be passed'],
  ]
  for (const [text, message] of errors) {
    test(`error: ${message}`, () => {
      expect(() => parseConfig(text)).toThrow(ConfigError)
      expect(() => parseConfig(text)).toThrow(message)
    })
  }
})

describe('configHash', () => {
  const base = parseConfig('schedule:\n  cron: "0 9 * * 1"\n')
  test('ignores comments, whitespace, key order, defaults and $schema', () => {
    const other = parseConfig(
      '$schema: https://example.com/s.json\n# comment\nversioning: increase\nschedule: { timezone: UTC,  cron: "0 9 * * 1" }\n',
    )
    expect(configHash(other)).toBe(configHash(base))
    expect(configHash(base)).toMatch(/^[0-9a-f]{64}$/)
  })
  test('fills in post_update defaults', () => {
    const short = parseConfig('schedule:\n  cron: "0 9 * * 1"\npost_update: [{run: a}]\n')
    const full = parseConfig('schedule:\n  cron: "0 9 * * 1"\npost_update: [{run: a, network: false, env: []}]\n')
    expect(configHash(short)).toBe(configHash(full))
    expect(configHash(short)).not.toBe(configHash(base))
  })
  test('changes with labels', () => {
    const other = parseConfig('schedule:\n  cron: "0 9 * * 1"\nlabels: [deps]\n')
    expect(configHash(other)).not.toBe(configHash(base))
  })
})
