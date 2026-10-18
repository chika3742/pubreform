// Registry proxy: relays pub.dev and hides versions published after the cutoff (detailed design §9).
// pub reads only `versions` from the listing, so `latest` is left as is.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { IgnoreRule } from './config.ts'
import { allows } from './version.ts'

export const PROXY_PORT = 8471
const UPSTREAM = 'https://pub.dev'
const TIMEOUT_MS = 30_000

export interface ProxyOptions {
  cutoff: Date
  /** package -> version locked in the base lockfile. Always kept visible. */
  locked: Map<string, string>
  ignore: IgnoreRule[]
  port?: number
  upstream?: string
}

interface Listing {
  versions: { version: string; published?: string }[]
  [key: string]: unknown
}

type Upstream = { ok: true; listing: Listing; type: string } | { ok: false; status: number; type: string; body: Buffer }

const LISTING_PATH = /^\/api\/packages\/([a-z0-9_]+)$/

export class RegistryProxy {
  private server?: http.Server
  /** Listings fetched in this run, so that every resolution sees the same versions. */
  private listings = new Map<string, Promise<Upstream>>()
  private readonly upstream: string
  port: number

  constructor(private readonly options: ProxyOptions) {
    this.upstream = options.upstream ?? UPSTREAM
    this.port = options.port ?? PROXY_PORT
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  start(): Promise<void> {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(502)
        res.end(String(e))
      })
    })
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', (e) => reject(new Error(`cannot start the registry proxy on port ${this.port}: ${e.message}`)))
      server.listen(this.port, '127.0.0.1', () => {
        this.port = (server.address() as AddressInfo).port
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }

  /** Versions that the proxy shows for the package. */
  async visibleVersions(name: string): Promise<string[]> {
    const upstream = await this.listing(name)
    if (!upstream.ok) throw new Error(`cannot get the versions of ${name}: HTTP ${upstream.status}`)
    return this.filter(name, upstream.listing).versions.map((v) => v.version)
  }

  private isHidden(name: string, version: string, published: string | undefined): boolean {
    if (this.options.locked.get(name) === version) return false
    if (!(published !== undefined && new Date(published) <= this.options.cutoff)) return true
    return this.options.ignore.some(
      (rule) => rule.name === name && (rule.versions === undefined || allows(rule.versions, version)),
    )
  }

  private filter(name: string, listing: Listing): Listing {
    return { ...listing, versions: listing.versions.filter((v) => !this.isHidden(name, v.version, v.published)) }
  }

  private listing(name: string): Promise<Upstream> {
    let cached = this.listings.get(name)
    if (!cached) {
      cached = this.fetchListing(name)
      this.listings.set(name, cached)
      // Do not keep failures, so that a later request can try again.
      cached.catch(() => this.listings.delete(name))
    }
    return cached
  }

  private async fetchListing(name: string): Promise<Upstream> {
    const res = await fetch(`${this.upstream}/api/packages/${name}`, {
      headers: { accept: 'application/vnd.pub.v2+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const type = res.headers.get('content-type') ?? 'application/json'
    if (!res.ok) return { ok: false, status: res.status, type, body: Buffer.from(await res.arrayBuffer()) }
    return { ok: true, listing: (await res.json()) as Listing, type }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = req.url ?? '/'
    const name = req.method === 'GET' ? LISTING_PATH.exec(path)?.[1] : undefined
    if (name) {
      const upstream = await this.listing(name)
      if (upstream.ok) {
        res.writeHead(200, { 'content-type': upstream.type })
        res.end(JSON.stringify(this.filter(name, upstream.listing)))
      } else {
        res.writeHead(upstream.status, { 'content-type': upstream.type })
        res.end(upstream.body)
      }
      return
    }
    const upstream = await fetch(this.upstream + path, {
      method: req.method,
      headers: { accept: req.headers.accept ?? '*/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream' })
    res.end(Buffer.from(await upstream.arrayBuffer()))
  }
}
