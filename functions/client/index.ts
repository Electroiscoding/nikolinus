export class Functions {
  constructor(
    readonly url: string,
    readonly auth?: { token(): Promise<string | null> },
    readonly extra: Record<string, string> = {}
  ) {}

  async call<T = unknown>(name: string, data?: unknown): Promise<T> {
    const t = await this.auth?.token()
    const r = await fetch(`${this.url}/call/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.extra, ...(t ? { authorization: `Bearer ${t}` } : {}) },
      body: JSON.stringify({ data })
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw Object.assign(new Error(j.error ?? r.statusText), { status: r.status })
    return j.data
  }
}
