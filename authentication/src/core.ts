import postgres from "postgres"
import { SignJWT, jwtVerify } from "jose"

export const sql = postgres(process.env.DATABASE_URL!, { max: 10 })

const key = new TextEncoder().encode(process.env.JWT_SECRET!)

type U = { id: string; email: string }

export const migrate = () =>
  sql.unsafe(`
    create table if not exists users (
      id uuid primary key default gen_random_uuid(),
      email text unique not null,
      password text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists sessions (
      token text primary key,
      user_id uuid not null references users(id) on delete cascade,
      expires_at timestamptz not null
    );
    create index if not exists sessions_user on sessions (user_id);
  `)

export const hash = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex")

export const verify = async (token: string) =>
  (await jwtVerify(token, key, { algorithms: ["HS256"] })).payload

export const pair = async (u: U) => {
  const raw = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
  await sql`insert into sessions (token, user_id, expires_at) values (${hash(raw)}, ${u.id}, now() + interval '30 days')`
  const access = await new SignJWT({ email: u.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(u.id)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(key)
  return { access, refresh: raw, user: { id: u.id, email: u.email } }
}

export const rotate = async (raw: string) => {
  const [s] = await sql`delete from sessions where token = ${hash(raw)} and expires_at > now() returning user_id`
  if (!s) return null
  const [u] = await sql`select id, email from users where id = ${s.user_id}`
  return u ? pair(u as U) : null
}
