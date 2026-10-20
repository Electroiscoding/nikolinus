type TokenSource = { token(): Promise<string | null> }
type Op = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "contains"
export type Doc = { id: string; created_at: string; updated_at: string; [k: string]: any }
type Spec = {
  collection: string
  where?: [string, Op, unknown][]
  orderBy?: [string, "asc" | "desc"]
  limit?: number
  offset?: number
}

const sort = (docs: Doc[], spec: Spec) => {
  const [f, d] = spec.orderBy ?? ["created_at", "asc"]
  const m = d === "desc" ? -1 : 1
  const pick = (o: Doc) => f.split(".").reduce<any>((a, k) => a?.[k], o)
  return docs.sort((a, b) => {
    const x = pick(a)
    const y = pick(b)
    return x > y ? m : x < y ? -m : 0
  })
}

export class Database {
  constructor(
    readonly url: string,
    readonly auth?: TokenSource,
    readonly extra: Record<string, string> = {}
  ) {}

  async headers() {
    const t = await this.auth?.token()
    return { "content-type": "application/json", ...this.extra, ...(t ? { authorization: `Bearer ${t}` } : {}) }
  }

  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const r = await fetch(this.url + path, {
      method,
      headers: await this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw Object.assign(new Error(j.error ?? r.statusText), { status: r.status })
    return j
  }

  collection(name: string) {
    return new Collection(this, { collection: name })
  }

  watch(spec: Spec, cb: (docs: Doc[]) => void, onError?: (e: unknown) => void) {
    const ac = new AbortController()
    const map = new Map<string, Doc>()
    let wait = 1000

    const emit = () => cb(sort([...map.values()], spec).slice(0, spec.limit ?? 50))

    const frame = (raw: string) => {
      let ev = ""
      let data = ""
      for (const l of raw.split("\n")) {
        if (l.startsWith("event: ")) ev = l.slice(7)
        else if (l.startsWith("data: ")) data += l.slice(6)
      }
      if (ev === "init") {
        map.clear()
        for (const d of JSON.parse(data) as Doc[]) map.set(d.id, d)
      } else if (ev === "upsert") {
        const d = JSON.parse(data) as Doc
        map.set(d.id, d)
      } else if (ev === "remove") map.delete(JSON.parse(data).id)
      else return
      emit()
    }

    const loop = async () => {
      while (!ac.signal.aborted) {
        try {
          const res = await fetch(this.url + "/watch", {
            method: "POST",
            headers: await this.headers(),
            body: JSON.stringify(spec),
            signal: ac.signal
          })
          if (!res.ok || !res.body) throw new Error(String(res.status))
          wait = 1000
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          let buf = ""
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let i: number
            while ((i = buf.indexOf("\n\n")) >= 0) {
              frame(buf.slice(0, i))
              buf = buf.slice(i + 2)
            }
          }
        } catch (e) {
          if (!ac.signal.aborted) {
            onError?.(e)
            wait = Math.min(wait * 2, 30000)
          }
        }
        if (!ac.signal.aborted) await new Promise((r) => setTimeout(r, wait))
      }
    }

    void loop()
    return () => ac.abort()
  }
}

export class Query {
  constructor(protected db: Database, protected spec: Spec) {}

  where(field: string, op: Op, value: unknown) {
    return new Query(this.db, { ...this.spec, where: [...(this.spec.where ?? []), [field, op, value]] })
  }

  orderBy(field: string, dir: "asc" | "desc" = "asc") {
    return new Query(this.db, { ...this.spec, orderBy: [field, dir] })
  }

  limit(n: number) {
    return new Query(this.db, { ...this.spec, limit: n })
  }

  offset(n: number) {
    return new Query(this.db, { ...this.spec, offset: n })
  }

  get() {
    return this.db.request<Doc[]>("/query", "POST", this.spec)
  }

  onSnapshot(cb: (docs: Doc[]) => void, onError?: (e: unknown) => void) {
    return this.db.watch(this.spec, cb, onError)
  }
}

export class Collection extends Query {
  add(data: object) {
    return this.db.request<Doc>(`/doc/${encodeURIComponent(this.spec.collection)}`, "POST", data)
  }

  doc(id: string) {
    return new Ref(this.db, this.spec.collection, id)
  }
}

export class Ref {
  constructor(private db: Database, private collection: string, readonly id: string) {}

  private get path() {
    return `/doc/${encodeURIComponent(this.collection)}/${encodeURIComponent(this.id)}`
  }

  get() {
    return this.db.request<Doc>(this.path).catch((e) => (e.status === 404 ? null : Promise.reject(e)))
  }

  set(data: object) {
    return this.db.request<Doc>(this.path, "PUT", data)
  }

  update(data: object) {
    return this.db.request<Doc>(this.path, "PATCH", data)
  }

  delete() {
    return this.db.request<{ ok: true }>(this.path, "DELETE")
  }
}
