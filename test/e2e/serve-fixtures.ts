// Runs the fixture registry on its own, for the GitHub E2E (detailed design §17.2).
//   bun test/e2e/serve-fixtures.ts [port]
// Publication dates are relative to the start of this process.
import { startFixtureServer } from './fixtures.ts'

const port = Number(process.argv[2] ?? 8472)
const server = await startFixtureServer({ port })
console.log(`Fixture registry listening on ${server.url}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await server.close()
    process.exit(0)
  })
}
