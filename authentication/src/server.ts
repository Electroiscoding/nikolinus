import { Hono, type Context } from "hono"
import { cors } from "hono/cors"
import { hash, migrate, pair, rotate, sql, verify } from "./core"

await migrate()

setInterval(() => sql`delete from sessions where expires_at < now()`.catch(() => {}), 3600000)

const creds = async (c: Context) => {
  const b = await c.req.json().catch(() => ({}))
  const email = String(b.email ?? "").trim().toLowerCase()
  const password = String(b.password ?? "")
  return { email, password, ok: /^\S+@\S+\.\S+$/.test(email) && password.length >= 8 && password.length <= 256 }
}

const refreshOf = async (c: Context) => {
  const b = await c.req.json().catch(() => ({}))
  return typeof b.refresh === "string" ? b.refresh : null
}

const app = new Hono()

app.use("*", cors({ maxAge: 86400 }))

app.onError((e, c) => {
  console.error(e)
  return c.json({ error: "internal" }, 500)
})

app.post("/signup", async (c) => {
  const { email, password, ok } = await creds(c)
  if (!ok) return c.json({ error: "invalid" }, 400)
  const pw = await Bun.password.hash(password)
  const [user] = await sql`insert into users (email, password) values (${email}, ${pw}) on conflict do nothing returning id, email`
  if (!user) return c.json({ error: "exists" }, 409)
  return c.json(await pair(user as { id: string; email: string }), 201)
})

app.post("/signin", async (c) => {
  const { email, password, ok } = await creds(c)
  if (!ok) return c.json({ error: "invalid" }, 400)
  const [user] = await sql`select id, email, password from users where email = ${email}`
  if (!user || !(await Bun.password.verify(password, user.password))) return c.json({ error: "denied" }, 401)
  return c.json(await pair(user as { id: string; email: string }))
})

app.post("/refresh", async (c) => {
  const raw = await refreshOf(c)
  const out = raw ? await rotate(raw) : null
  return out ? c.json(out) : c.json({ error: "denied" }, 401)
})

app.post("/signout", async (c) => {
  const raw = await refreshOf(c)
  if (raw) await sql`delete from sessions where token = ${hash(raw)}`
  return c.json({ ok: true })
})

app.get("/me", async (c) => {
  const t = c.req.header("authorization")?.slice(7)
  const p = t ? await verify(t).catch(() => null) : null
  return p ? c.json({ id: p.sub, email: p.email }) : c.json({ error: "denied" }, 401)
})

export default { port: Number(process.env.PORT ?? 4001), fetch: app.fetch, maxRequestBodySize: 1 << 16 }
