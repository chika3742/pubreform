// Fixture registry for the E2E tests.
// Serves package listings and archives in the hosted pub repository format, in place of pub.dev.
// Archives are built to be byte-identical for the same definition, so that lockfile sha256 values stay fixed.
import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FixtureVersion {
  version: string
  /** Published this many days before the server starts. */
  daysAgo: number
  dependencies?: Record<string, string>
  /** Dart SDK constraint. Defaults to ^3.0.0. */
  sdk?: string
  retracted?: boolean
}

export type Fixtures = Record<string, FixtureVersion[]>

/** package -> advisories in the OSV format, as pub.dev returns them. */
export type Advisories = Record<string, object[]>

/** Packages that produce each case of the local E2E. Every package starts locked at 1.0.0. */
export function defaultFixtures(): Fixtures {
  const old = (version: string, extra: Partial<FixtureVersion> = {}) => ({ version, daysAgo: 30, ...extra })
  const base = { version: '1.0.0', daysAgo: 60 }
  return {
    // Minor and patch group (N = 3, with fx_pinned).
    fx_patch: [base, old('1.0.1')],
    fx_minor: [base, old('1.2.0')],
    // Single.
    fx_major: [base, old('2.0.0')],
    // Pinned (fx_pinned: 1.0.0): 1.1.0 goes into the minor and patch group, 2.0.0 into a single.
    fx_pinned: [base, old('1.1.0'), old('2.0.0')],
    // Group {fx_b, fx_needs_b}.
    fx_needs_b: [base, old('1.1.0', { dependencies: { fx_b: '^2.0.0' } })],
    fx_b: [base, old('2.0.0')],
    // Unresolvable: needs a future Dart SDK.
    fx_sdk: [base, old('2.0.0', { sdk: '^99.0.0' })],
    // Still in the release age window (min_release_age_days: 3).
    fx_fresh: [base, { version: '1.1.0', daysAgo: 1 }],
    // Ignored by the config.
    fx_ignored: [base, old('1.1.0')],
    // Security advisories (scenarios 12 and 13): only 1.0.0 until then.
    fx_vuln: [base],
    fx_parent: [{ ...base, dependencies: { fx_child: '^1.0.0' } }],
    fx_child: [base],
    fx_late: [base],
  }
}

function pubspecOf(name: string, v: FixtureVersion) {
  return {
    name,
    version: v.version,
    description: `Fixture package ${name} for pubreform tests.`,
    repository: `https://example.com/${name}`,
    environment: { sdk: v.sdk ?? '^3.0.0' },
    ...(v.dependencies ? { dependencies: v.dependencies } : {}),
  }
}

function changelogOf(name: string, versions: FixtureVersion[], upTo: string): string {
  const included = versions.slice(0, versions.findIndex((v) => v.version === upTo) + 1).reverse()
  return `# Changelog\n\n${included.map((v) => `## ${v.version}\n\n- ${name} ${v.version}.\n`).join('\n')}`
}

// ---- Deterministic tar.gz ----

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512)
  const field = (offset: number, length: number, value: string) => header.write(value, offset, length, 'ascii')
  const octal = (offset: number, length: number, value: number) =>
    field(offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`)
  field(0, 100, name)
  octal(100, 8, 0o644)
  octal(108, 8, 0)
  octal(116, 8, 0)
  octal(124, 12, size)
  octal(136, 12, 0) // mtime fixed to the epoch
  field(148, 8, '        ')
  field(156, 1, '0')
  field(257, 6, 'ustar\0')
  field(263, 2, '00')
  let sum = 0
  for (const byte of header) sum += byte
  field(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  return header
}

function tar(files: [name: string, content: string][]): Buffer {
  const parts: Buffer[] = []
  for (const [name, content] of files) {
    const data = Buffer.from(content)
    parts.push(tarHeader(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** gzip with stored (uncompressed) deflate blocks and no time in the header: the same bytes in any runtime. */
function gzipStored(data: Buffer): Buffer {
  const parts: Buffer[] = [Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff])]
  for (let offset = 0; offset < data.length || offset === 0; offset += 0xffff) {
    const chunk = data.subarray(offset, offset + 0xffff)
    const last = offset + 0xffff >= data.length
    const header = Buffer.alloc(5)
    header[0] = last ? 1 : 0
    header.writeUInt16LE(chunk.length, 1)
    header.writeUInt16LE(~chunk.length & 0xffff, 3)
    parts.push(header, chunk)
    if (last) break
  }
  const trailer = Buffer.alloc(8)
  trailer.writeUInt32LE(crc32(data), 0)
  trailer.writeUInt32LE(data.length >>> 0, 4)
  parts.push(trailer)
  return Buffer.concat(parts)
}

export function archiveOf(name: string, versions: FixtureVersion[], version: string): Buffer {
  const v = versions.find((x) => x.version === version)
  if (!v) throw new Error(`no fixture ${name} ${version}`)
  return gzipStored(
    tar([
      ['pubspec.yaml', JSON.stringify(pubspecOf(name, v), null, 2) + '\n'],
      ['CHANGELOG.md', changelogOf(name, versions, version)],
      [`lib/${name}.dart`, `const version = '${version}';\n`],
    ]),
  )
}

// ---- Server ----

export interface FixtureServer {
  url: string
  /** Adds a version while the server runs. */
  addVersion(name: string, version: FixtureVersion): void
  /** Adds a security advisory (OSV) while the server runs. */
  addAdvisory(name: string, advisory: object): void
  close(): Promise<void>
}

export async function startFixtureServer(
  options: { port?: number; fixtures?: Fixtures; advisories?: Advisories; now?: Date } = {},
): Promise<FixtureServer> {
  const fixtures = options.fixtures ?? defaultFixtures()
  const advisories: Advisories = { ...options.advisories }
  const now = options.now ?? new Date()
  let url = ''

  const listing = (name: string) => {
    const versions = fixtures[name]!
    const entries = versions.map((v) => {
      const archive = archiveOf(name, versions, v.version)
      return {
        version: v.version,
        pubspec: pubspecOf(name, v),
        archive_url: `${url}/packages/${name}/versions/${v.version}.tar.gz`,
        archive_sha256: createHash('sha256').update(archive).digest('hex'),
        published: new Date(now.getTime() - v.daysAgo * 24 * 60 * 60 * 1000).toISOString(),
        ...(v.retracted ? { retracted: true } : {}),
      }
    })
    // As pub.dev: advisoriesUpdated only when the package has advisories.
    const updated = advisories[name]?.length ? { advisoriesUpdated: now.toISOString() } : {}
    return { name, latest: entries[entries.length - 1], versions: entries, ...updated }
  }

  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    let m: RegExpExecArray | null
    if ((m = /^\/api\/packages\/([a-z0-9_]+)$/.exec(path)) && fixtures[m[1]!]) {
      res.writeHead(200, { 'content-type': 'application/vnd.pub.v2+json' })
      res.end(JSON.stringify(listing(m[1]!)))
    } else if ((m = /^\/api\/packages\/([a-z0-9_]+)\/advisories$/.exec(path)) && fixtures[m[1]!]) {
      res.writeHead(200, { 'content-type': 'application/vnd.pub.v2+json' })
      res.end(JSON.stringify({ advisories: advisories[m[1]!] ?? [], advisoriesUpdated: now.toISOString() }))
    } else if ((m = /^\/packages\/([a-z0-9_]+)\/versions\/(.+)\.tar\.gz$/.exec(path)) && fixtures[m[1]!]) {
      try {
        const archive = archiveOf(m[1]!, fixtures[m[1]!]!, m[2]!)
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(archive)
      } catch {
        res.writeHead(404).end()
      }
    } else {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'NotFound', message: `not found: ${path}` } }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    url,
    addVersion(name, version) {
      fixtures[name]!.push(version)
    },
    addAdvisory(name, advisory) {
      advisories[name] = [...(advisories[name] ?? []), advisory]
    },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
