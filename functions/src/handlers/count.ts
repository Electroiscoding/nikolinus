import type { Ctx } from "../core"

export default async (ctx: Ctx, data: { collection: string }) => {
  const [r] = await ctx.sql`
    select count(*)::int as n from documents
    where collection = ${String(data?.collection)} and owner = ${ctx.uid}`
  return r
}
