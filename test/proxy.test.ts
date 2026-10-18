import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { RegistryProxy } from '../src/proxy.ts'

// A fake pub.dev.
let upstream: http.Server
let upstreamUrl: string
const requests: string[] = []
let flakyFailures = 0
const listing = (name: string) => ({
  name,
  latest: { version: '3.0.0' },
  versions: [
    { version: '1.0.0', published: '2026-01-01T00:00:00Z' },
    { version: '1.1.0', published: '2026-02-01T00:00:00Z' },
    { version: '2.0.0', published: '2026-03-01T00:00:00Z' },
    { version: '3.0.0', published: '2026-05-01T00:00:00Z' },
  ],
})

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    requests.push(req.url!)
    if (req.url === '/api/packages/flaky' && flakyFailures > 0) {
      flakyFailures--
      res.writeHead(500, { 'content-type': 'text/plain' }).end('server error')
    } else if (req.url === '/api/packages/missing') {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}')
    } else if (/^\/api\/packages\/[a-z_]+$/.test(req.url!)) {
      res.writeHead(200, { 'content-type': 'application/vnd.pub.v2+json' })
      res.end(JSON.stringify(listing(req.url!.split('/')[3]!)))
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`passthrough ${req.url}`)
    }
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
})
afterAll(() => upstream.close())

async function withProxy(
  options: Partial<ConstructorParameters<typeof RegistryProxy>[0]>,
  f: (proxy: RegistryProxy) => Promise<void>,
) {
  const proxy = new RegistryProxy({
    cutoff: new Date('2026-03-15T00:00:00Z'),
    locked: new Map(),
    ignore: [],
    port: 0,
    upstream: upstreamUrl,
    ...options,
  })
  await proxy.start()
  try {
    await f(proxy)
  } finally {
    await proxy.stop()
  }
}

const versionsOf = async (url: string) =>
  ((await (await fetch(url)).json()) as { versions: { version: string }[] }).versions.map((v) => v.version)

describe('RegistryProxy', () => {
  test('hides versions published after the cutoff', async () => {
    await withProxy({}, async (proxy) => {
      expect(await versionsOf(`${proxy.url}/api/packages/foo`)).toEqual(['1.0.0', '1.1.0', '2.0.0'])
      expect(await proxy.visibleVersions('foo')).toEqual(['1.0.0', '1.1.0', '2.0.0'])
    })
  })
  test('keeps locked versions and applies ignore rules', async () => {
    await withProxy(
      {
        locked: new Map([['foo', '3.0.0'], ['bar', '1.0.0']]),
        ignore: [{ name: 'foo', versions: '>=2.0.0' }, { name: 'bar' }],
      },
      async (proxy) => {
        expect(await proxy.visibleVersions('foo')).toEqual(['1.0.0', '1.1.0', '3.0.0'])
        expect(await proxy.visibleVersions('bar')).toEqual(['1.0.0'])
        expect(await proxy.visibleVersions('baz')).toEqual(['1.0.0', '1.1.0', '2.0.0'])
      },
    )
  })
  test('fetches a listing once per run', async () => {
    await withProxy({}, async (proxy) => {
      requests.length = 0
      await versionsOf(`${proxy.url}/api/packages/once`)
      await versionsOf(`${proxy.url}/api/packages/once`)
      await proxy.visibleVersions('once')
      expect(requests).toEqual(['/api/packages/once'])
    })
  })
  test('fetches a listing again after an error response', async () => {
    await withProxy({}, async (proxy) => {
      requests.length = 0
      flakyFailures = 1
      expect((await fetch(`${proxy.url}/api/packages/flaky`)).status).toBe(500)
      expect(await proxy.visibleVersions('flaky')).toEqual(['1.0.0', '1.1.0', '2.0.0'])
      await proxy.visibleVersions('flaky')
      expect(requests).toEqual(['/api/packages/flaky', '/api/packages/flaky'])
    })
  })
  test('passes errors and other paths through', async () => {
    await withProxy({}, async (proxy) => {
      const missing = await fetch(`${proxy.url}/api/packages/missing`)
      expect(missing.status).toBe(404)
      expect(await missing.text()).toBe('{"error":"not found"}')
      await expect(proxy.visibleVersions('missing')).rejects.toThrow('HTTP 404')
      const other = await fetch(`${proxy.url}/api/packages/foo/advisories`)
      expect(await other.text()).toBe('passthrough /api/packages/foo/advisories')
    })
  })
  test('returns 502 when pub.dev is unreachable', async () => {
    await withProxy({ upstream: 'http://127.0.0.1:1' }, async (proxy) => {
      expect((await fetch(`${proxy.url}/api/packages/foo`)).status).toBe(502)
    })
  })
  test('fails to start when the port is in use', async () => {
    await withProxy({}, async (proxy) => {
      const other = new RegistryProxy({ cutoff: new Date(), locked: new Map(), ignore: [], port: proxy.port })
      await expect(other.start()).rejects.toThrow(`port ${proxy.port}`)
    })
  })
})
