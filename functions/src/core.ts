import postgres from "postgres"
import { jwtVerify } from "jose"
import { timingSafeEqual } from "node:crypto"

export const sql = postgres(process.env.DATABASE_URL!, { max: 10 })

const key = new TextEncoder().encode(process.env.JWT_SECRET!)
const service = process.env.SERVICE_KEY ?? ""

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export type Ctx = { uid: string | null; admin: boolean; sql: typeof sql; headers: Headers }

export const identify = async (auth?: string, svc?: string) => {
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
