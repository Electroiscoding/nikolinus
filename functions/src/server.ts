import { Hono } from "hono"
import { cors } from "hono/cors"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { identify, sql, type Ctx } from "./core"

type Entry = { run: (ctx: Ctx, data: any) => unknown; open: boolean; timeout: number }

const registry = new Map<string, Entry>()
const dir = join(import.meta.dir, "handlers")

for (const f of readdirSync(dir)) {
  if (!f.endsWith(".ts")) continue
  const m = await import(join(dir, f))
  registry.set(f.slice(0, -3), { run: m.default, open: m.open === true, timeout: m.timeout ?? 10000 })
}

const within = <T>(p: Promise<T>, ms: number) =>
  new Promise<T>((ok, no) => {
    const t = setTimeout(() => no(Object.assign(new Error("timeout"), { status: 504 })), ms)
    p.then(ok, no).finally(() => clearTimeout(t))
  })

const app = new Hono()

app.use("*", cors({ maxAge: 86400 }))

app.post("/call/:name", async (c) => {
  const fn = registry.get(c.req.param("name"))
  if (!fn) return c.json({ error: "missing" }, 404)
  const who = await identify(c.req.header("authorization"), c.req.header("x-service-key"))
  if (!fn.open && !who.uid && !who.admin) return c.json({ error: "denied" }, 401)
  const body = await c.req.json().catch(() => ({}))
  try {
    const out = await within(
      Promise.resolve().then(() => fn.run({ ...who, sql, headers: c.req.raw.headers }, body?.data)),
      fn.timeout
    )
    return c.json({ data: out ?? null })
  } catch (e: any) {
    if (!e?.status) console.error(e)
    return c.json({ error: e?.status ? e.message : "internal" }, e?.status ?? 500)
  }
})

export default { port: Number(process.env.PORT ?? 4003), fetch: app.fetch, maxRequestBodySize: 1 << 20 }
