// Config file: loading, validation and hash.
// The checks here must agree with pubreform.schema.json (test/config-schema.test.ts).
import { createHash } from 'node:crypto'
import { CronExpressionParser } from 'cron-parser'
import { parse } from 'yaml'
import { allows, parseConstraint } from './version.ts'

export type Versioning = 'increase' | 'lockfile-only'

export interface IgnoreRule {
  name: string
  versions?: string
}

/** Whether an `ignore` rule covers the version: the same name, and no `versions` or a constraint that allows it. */
export function isIgnored(rules: IgnoreRule[], name: string, version: string): boolean {
  return rules.some((rule) => rule.name === name && (rule.versions === undefined || allows(rule.versions, version)))
}

export interface PostUpdate {
  run: string
  network: boolean
  /** Names of more environment variables to pass. */
  env: string[]
}

export interface Config {
  schedule: { cron: string; timezone: string }
  min_release_age_days: number
  labels: string[]
  versioning: Versioning
  ignore: IgnoreRule[]
  post_update: PostUpdate[]
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

const CRON_FIELDS = /^\s*\S+(\s+\S+){4}\s*$/
const PACKAGE_NAME = /^[a-z_][a-z0-9_]*$/
// The strict form of pubreform.schema.json: comparisons separated by whitespace, no whitespace after operators.
const COMPARISON = String.raw`(\^|>=|>|<=|<)?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?`
const STRICT_CONSTRAINT = new RegExp(String.raw`^(any|${COMPARISON}(\s+${COMPARISON})*)$`)
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
// The inputs of pubreform (the App token) and the tokens of the runner.
const RESERVED_ENV = /^(INPUT_|ACTIONS_)/

type Obj = Record<string, unknown>

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function fail(path: string, message: string): never {
  throw new ConfigError(path ? `${path}: ${message}` : message)
}

function checkKeys(obj: Obj, path: string, allowed: string[]) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(path ? `${path}.${key}` : key, 'unknown key')
  }
}

function requireString(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, 'must be a string')
  return v
}

function parseSchedule(v: unknown): Config['schedule'] {
  if (!isObject(v)) fail('schedule', 'must be a map')
  checkKeys(v, 'schedule', ['cron', 'timezone'])
  if (v.cron === undefined) fail('schedule.cron', 'is required')
  const cron = requireString(v.cron, 'schedule.cron')
  if (!CRON_FIELDS.test(cron)) fail('schedule.cron', `must have 5 fields: "${cron}"`)
  try {
    CronExpressionParser.parse(cron, { tz: 'UTC' })
  } catch (e) {
    fail('schedule.cron', `invalid cron expression "${cron}": ${(e as Error).message}`)
  }
  let timezone = 'UTC'
  if (v.timezone !== undefined) {
    timezone = requireString(v.timezone, 'schedule.timezone')
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: timezone })
    } catch {
      fail('schedule.timezone', `unknown time zone "${timezone}"`)
    }
  }
  return { cron, timezone }
}

function parseLabels(v: unknown): string[] {
  if (!Array.isArray(v)) fail('labels', 'must be a list')
  const labels = v.map((label, i) => {
    const s = requireString(label, `labels[${i}]`)
    if (s === '') fail(`labels[${i}]`, 'must not be empty')
    return s
  })
  labels.forEach((label, i) => {
    if (labels.indexOf(label) !== i) fail(`labels[${i}]`, `duplicate label "${label}"`)
  })
  return labels
}

function parseIgnore(v: unknown): IgnoreRule[] {
  if (!Array.isArray(v)) fail('ignore', 'must be a list')
  return v.map((item, i) => {
    const path = `ignore[${i}]`
    if (!isObject(item)) fail(path, 'must be a map')
    checkKeys(item, path, ['name', 'versions'])
    if (item.name === undefined) fail(`${path}.name`, 'is required')
    const name = requireString(item.name, `${path}.name`)
    if (!PACKAGE_NAME.test(name)) fail(`${path}.name`, `invalid package name "${name}"`)
    const rule: IgnoreRule = { name }
    if (item.versions !== undefined) {
      const versions = requireString(item.versions, `${path}.versions`)
      if (!STRICT_CONSTRAINT.test(versions)) fail(`${path}.versions`, `invalid version constraint "${versions}"`)
      try {
        parseConstraint(versions)
      } catch (e) {
        fail(`${path}.versions`, (e as Error).message)
      }
      rule.versions = versions
    }
    return rule
  })
}

function parsePostUpdate(v: unknown): PostUpdate[] {
  if (!Array.isArray(v)) fail('post_update', 'must be a list')
  return v.map((item, i) => {
    const path = `post_update[${i}]`
    if (!isObject(item)) fail(path, 'must be a map')
    checkKeys(item, path, ['run', 'network', 'env'])
    if (item.run === undefined) fail(`${path}.run`, 'is required')
    const run = requireString(item.run, `${path}.run`)
    if (run === '') fail(`${path}.run`, 'must not be empty')
    let network = false
    if (item.network !== undefined) {
      if (typeof item.network !== 'boolean') fail(`${path}.network`, 'must be true or false')
      network = item.network
    }
    let env: string[] = []
    if (item.env !== undefined) {
      if (!Array.isArray(item.env)) fail(`${path}.env`, 'must be a list')
      env = item.env.map((name, j) => {
        const p = `${path}.env[${j}]`
        const s = requireString(name, p)
        if (!ENV_NAME.test(s)) fail(p, `invalid environment variable name "${s}"`)
        if (RESERVED_ENV.test(s)) fail(p, `"${s}" must not be passed: names starting with INPUT_ or ACTIONS_ are reserved`)
        return s
      })
      env.forEach((name, j) => {
        if (env.indexOf(name) !== j) fail(`${path}.env[${j}]`, `duplicate name "${name}"`)
      })
    }
    return { run, network, env }
  })
}

/** Validates a parsed config and fills in defaults. Throws ConfigError. */
export function validateConfig(raw: unknown): Config {
  if (!isObject(raw)) fail('', 'the config must be a map')
  checkKeys(raw, '', [
    '$schema',
    'schedule',
    'min_release_age_days',
    'labels',
    'versioning',
    'ignore',
    'post_update',
  ])
  if (raw.$schema !== undefined) requireString(raw.$schema, '$schema')
  if (raw.schedule === undefined) fail('schedule', 'is required')
  const schedule = parseSchedule(raw.schedule)

  let minReleaseAgeDays = 0
  if (raw.min_release_age_days !== undefined) {
    const v = raw.min_release_age_days
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      fail('min_release_age_days', 'must be an integer of 0 or more')
    }
    minReleaseAgeDays = v
  }

  let versioning: Versioning = 'increase'
  if (raw.versioning !== undefined) {
    if (raw.versioning !== 'increase' && raw.versioning !== 'lockfile-only') {
      fail('versioning', 'must be "increase" or "lockfile-only"')
    }
    versioning = raw.versioning
  }

  return {
    schedule,
    min_release_age_days: minReleaseAgeDays,
    labels: raw.labels === undefined ? [] : parseLabels(raw.labels),
    versioning,
    ignore: raw.ignore === undefined ? [] : parseIgnore(raw.ignore),
    post_update: raw.post_update === undefined ? [] : parsePostUpdate(raw.post_update),
  }
}

/** Parses and validates the config file. Throws ConfigError. */
export function parseConfig(text: string): Config {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (e) {
    fail('', `not valid YAML: ${(e as Error).message}`)
  }
  return validateConfig(raw)
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (isObject(v)) {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys(v[k])]),
    )
  }
  return v
}

/** SHA-256 of the config with defaults, as JSON with sorted keys. */
export function configHash(config: Config): string {
  return createHash('sha256').update(JSON.stringify(sortKeys(config))).digest('hex')
}
