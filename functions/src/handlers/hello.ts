import type { Ctx } from "../core"

export const open = true

export default async (ctx: Ctx, data: { name?: string }) => ({
  message: `hello ${data?.name ?? "world"}`,
  uid: ctx.uid
})
