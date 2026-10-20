import { sql } from "./core"

const OPS = ["==", "!=", "<", "<=", ">", ">=", "in", "contains"] as const
const META = new Set(["id", "created_at", "updated_at"])
const NAME = /^[\w.:-]{1,128}$/
const FIELD = /^.{1,128}$/s

type Op = (typeof OPS)[number]
type Where = [string, Op, unknown]

export type Query = {
  collection: string
  where: Where[]
  orderBy: [string, "asc" | "desc"]
  limit: number
  offset: number
}

const path = (f: string) => sql`string_to_array(${f}::text, '.')`
const jb = (f: string) => sql`(data #> ${path(f)})`
const txt = (f: string) => (META.has(f) ? sql`(${sql(f)}::text)` : sql`(data #>> ${path(f)})`)
const order = (f: string) => (META.has(f) ? sql`${sql(f)}` : jb(f))

const cmp = (op: string) => {
  switch (op) {
    case "==": return sql`=`
    case "!=": return sql`<>`
    case "<": return sql`<`
    case "<=": return sql`<=`
    case ">": return sql`>`
    default: return sql`>=`
  }
}

const cond = ([f, op, v]: Where) => {
  if (op === "contains") return sql`${jb(f)} @> ${JSON.stringify(v)}::jsonb`
  if (op === "in") {
    const list = (Array.isArray(v) ? v : []).slice(0, 100).map(String)
    return list.length ? sql`${txt(f)} in ${sql(list)}` : sql`false`
  }
  if (v === null) return op === "==" ? sql`${txt(f)} is null` : sql`${txt(f)} is not null`
  const o = cmp(op)
  if (typeof v === "number")
    return sql`(case when jsonb_typeof(${jb(f)}) = 'number' then ${txt(f)}::numeric end) ${o} ${v}::numeric`
  if (typeof v === "boolean")
    return sql`(case when jsonb_typeof(${jb(f)}) = 'boolean' then ${txt(f)}::boolean end) ${o} ${v}::boolean`
  return sql`${txt(f)} ${o} ${String(v)}::text`
}

export const parse = (b: any): Query => {
  if (typeof b?.collection !== "string" || !NAME.test(b.collection)) throw new Error("collection")
  const where: Where[] = (Array.isArray(b.where) ? b.where : []).slice(0, 10).map((w: any) => {
    if (!Array.isArray(w) || typeof w[0] !== "string" || !FIELD.test(w[0]) || !(OPS as readonly unknown[]).includes(w[1]))
      throw new Error("where")
    return [w[0], w[1], w[2]]
  })
  const o = Array.isArray(b.orderBy) ? b.orderBy : ["created_at", "asc"]
  if (typeof o[0] !== "string" || !FIELD.test(o[0])) throw new Error("orderBy")
  return {
    collection: b.collection,
    where,
    orderBy: [o[0], o[1] === "desc" ? "desc" : "asc"],
    limit: Math.min(Math.max(Math.trunc(Number(b.limit)) || 50, 1), 1000),
    offset: Math.max(Math.trunc(Number(b.offset)) || 0, 0)
  }
}

export const select = (q: Query, own: string | null, id?: string) => {
  const parts = [sql`collection = ${q.collection}`, ...q.where.map(cond)]
  if (own) parts.push(sql`owner = ${own}`)
  if (id) parts.push(sql`id = ${id}`)
  return sql`
    select id, data, created_at, updated_at from documents
    where ${parts.reduce((a, b) => sql`${a} and ${b}`)}
    order by ${order(q.orderBy[0])} ${q.orderBy[1] === "desc" ? sql`desc` : sql`asc`}, id
    limit ${id ? 1 : q.limit} offset ${id ? 0 : q.offset}`
}
