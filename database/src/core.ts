import postgres from "postgres"
import { jwtVerify } from "jose"
import { timingSafeEqual } from "node:crypto"

export const sql = postgres(process.env.DATABASE_URL!, { max: 20 })

const key = new TextEncoder().encode(process.env.JWT_SECRET!)
const service = process.env.SERVICE_KEY ?? ""

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export type Who = { uid: string | null; admin: boolean }
type Rule = { read: string; write: string }

export const migrate = () =>
  sql.unsafe(`
    create table if not exists documents (
      collection text not null,
      id text not null,
      owner uuid,
      data jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (collection, id)
    );
    create index if not exists documents_owner on documents (collection, owner);
    create index if not exists documents_created on documents (collection, created_at);
    create index if not exists documents_data on documents using gin (data jsonb_path_ops);
    create table if not exists rules (
      collection text primary key,
      read text not null default 'owner',
      write text not null default 'owner'
    );
  `)

export const identify = async (auth?: string, svc?: string): Promise<Who> => {
  if (svc && service && same(svc, service)) return { uid: null, admin: true }
  const t = auth?.startsWith("Bearer ") ? auth.slice(7) : null
  if (!t) return { uid: null, admin: false }
  try {
    const { payload } = await jwtVerify(t, key, { algorithms: ["HS256"] })
    return { uid: payload.sub ?? null, admin: false }
  } catch {
    return { uid: null, admin: false }
  }
}

const cache = new Map<string, { r: Rule; t: number }>()

export const rule = async (collection: string): Promise<Rule> => {
  const hit = cache.get(collection)
  if (hit && hit.t > Date.now()) return hit.r
  const [row] = await sql`select read, write from rules where collection = ${collection}`
  const r = row ? { read: row.read, write: row.write } : { read: "owner", write: "owner" }
  cache.set(collection, { r, t: Date.now() + 5000 })
  return r
}

export const scope = (mode: string, who: Who): "all" | "own" | "deny" => {
  if (who.admin || mode === "public") return "all"
  if (!who.uid || mode === "none") return "deny"
  return mode === "auth" ? "all" : "own"
}
