import { Hono, type Context } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { identify, migrate, rule, scope, sql } from "./core"
import { parse, select } from "./query"

await migrate()

const NAME = /^[\w.:-]{1,128}$/
const MODES = ["public", "auth", "owner", "none"]

const flat = (r: any) => ({ ...r.data, id: r.id, created_at: r.created_at, updated_at: r.updated_at })

const clean = (b: unknown) => {
  if (!b || typeof b !== "object" || Array.isArray(b)) return null
  const { id, created_at, updated_at, ...rest } = b as Record<string, unknown>
  return rest
}

const guard = async (c: Context, collection: string, action: "read" | "write") => {
  const who = await identify(c.req.header("authorization"), c.req.header("x-service-key"))
  const s = scope((await rule(collection))[action], who)
  return { who, ok: s !== "deny", own: s === "own" ? who.uid : null }
}

type Guard = Awaited<ReturnType<typeof guard>>

const deny = (c: Context, g: Guard) => c.json({ error: "denied" }, g.who.uid ? 403 : 401)

const save = async (c: Context, collection: string, id: string, merge: boolean) => {
  const g = await guard(c, collection, "write")
  if (!g.ok) return deny(c, g)
  const data = clean(await c.req.json().catch(() => null))
  if (!data) return c.json({ error: "invalid" }, 400)
  const [row] = await sql`
    insert into documents (collection, id, owner, data)
    values (${collection}, ${id}, ${g.who.uid}, ${sql.json(data as any)})
    on conflict (collection, id) do update
    set data = ${merge ? sql`documents.data || excluded.data` : sql`excluded.data`}, updated_at = now()
    where ${g.own ? sql`documents.owner = ${g.own}` : sql`true`}
    returning id, data, created_at, updated_at`
  if (!row) return c.json({ error: "denied" }, 403)
  await sql.notify("nk", JSON.stringify({ c: collection, id }))
  return c.json(flat(row))
}

const app = new Hono()

app.use("*", cors({ maxAge: 86400 }))

app.onError((e, c) => {
  console.error(e)
  return c.json({ error: "internal" }, 500)
})

app.use("/doc/:collection/:id?", async (c, next) => {
  const { collection, id } = c.req.param()
  return NAME.test(collection) && (!id || NAME.test(id)) ? next() : c.json({ error: "invalid" }, 400)
})

app.post("/doc/:collection", (c) => save(c, c.req.param("collection"), Bun.randomUUIDv7(), false))

app.put("/doc/:collection/:id", (c) => save(c, c.req.param("collection"), c.req.param("id"), false))

app.patch("/doc/:collection/:id", (c) => save(c, c.req.param("collection"), c.req.param("id"), true))

app.get("/doc/:collection/:id", async (c) => {
  const { collection, id } = c.req.param()
  const g = await guard(c, collection, "read")
  if (!g.ok) return deny(c, g)
  const [row] = await sql`
    select id, data, created_at, updated_at from documents
    where collection = ${collection} and id = ${id} and ${g.own ? sql`owner = ${g.own}` : sql`true`}`
  return row ? c.json(flat(row)) : c.json({ error: "missing" }, 404)
})

app.delete("/doc/:collection/:id", async (c) => {
  const { collection, id } = c.req.param()
  const g = await guard(c, collection, "write")
  if (!g.ok) return deny(c, g)
  const rows = await sql`
    delete from documents
    where collection = ${collection} and id = ${id} and ${g.own ? sql`owner = ${g.own}` : sql`true`}
    returning id`
  if (!rows.length) return c.json({ error: "missing" }, 404)
  await sql.notify("nk", JSON.stringify({ c: collection, id }))
  return c.json({ ok: true })
})

app.post("/query", async (c) => {
  const q = await c.req.json().then(parse).catch(() => null)
  if (!q) return c.json({ error: "invalid" }, 400)
  const g = await guard(c, q.collection, "read")
  if (!g.ok) return deny(c, g)
  return c.json((await select(q, g.own)).map(flat))
})

app.post("/watch", async (c) => {
  const q = await c.req.json().then(parse).catch(() => null)
  if (!q) return c.json({ error: "invalid" }, 400)
  const g = await guard(c, q.collection, "read")
  if (!g.ok) return deny(c, g)
  c.header("x-accel-buffering", "no")
  return streamSSE(c, async (s) => {
    const send = (event: string, d: unknown) => s.writeSSE({ event, data: JSON.stringify(d) })
    const sub = await sql.listen("nk", (p) => {
      const m = JSON.parse(p)
      if (m.c !== q.collection) return
      select(q, g.own, m.id)
        .then(([r]) => (r ? send("upsert", flat(r)) : send("remove", { id: m.id })))
        .catch(() => {})
    })
    await send("init", (await select(q, g.own)).map(flat))
    for (let i = 0; i < 40 && !s.aborted; i++) {
      await s.sleep(15000)
      await send("ping", 1)
    }
    await sub.unlisten()
  })
})

app.put("/rules/:collection", async (c) => {
  const { collection } = c.req.param()
  if (!NAME.test(collection)) return c.json({ error: "invalid" }, 400)
  const who = await identify(c.req.header("authorization"), c.req.header("x-service-key"))
  if (!who.admin) return c.json({ error: "denied" }, 403)
  const b = await c.req.json().catch(() => ({}))
  const read = MODES.includes(b.read) ? b.read : "owner"
  const write = MODES.includes(b.write) ? b.write : "owner"
  await sql`
    insert into rules (collection, read, write) values (${collection}, ${read}, ${write})
    on conflict (collection) do update set read = excluded.read, write = excluded.write`
  return c.json({ collection, read, write })
})

export default { port: Number(process.env.PORT ?? 4002), fetch: app.fetch, idleTimeout: 120, maxRequestBodySize: 1 << 20 }
