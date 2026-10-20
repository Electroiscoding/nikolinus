export type User = { id: string; email: string }
type Session = { access: string; refresh: string; user: User }
type Store = {
  getItem(k: string): string | null | Promise<string | null>
  setItem(k: string, v: string): void | Promise<void>
  removeItem(k: string): void | Promise<void>
}

const KEY = "nikolinus.session"

const defaultStore = (): Store | undefined => {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

const expiry = (jwt: string) =>
  JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp * 1000

export class Auth {
  private session: Session | null = null
  private ready: Promise<void>
  private pending: Promise<Session | null> | null = null
  private listeners = new Set<(u: User | null) => void>()

  constructor(readonly url: string, private store: Store | undefined = defaultStore()) {
    this.ready = Promise.resolve(store?.getItem(KEY)).then((v) => {
      if (v) this.session = JSON.parse(v)
    })
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(this.url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw Object.assign(new Error(j.error ?? r.statusText), { status: r.status })
    return j
  }

  private async set(s: Session | null) {
    this.session = s
    if (s) await this.store?.setItem(KEY, JSON.stringify(s))
    else await this.store?.removeItem(KEY)
    this.listeners.forEach((f) => f(s?.user ?? null))
  }

  async signUp(email: string, password: string) {
    const s = await this.post<Session>("/signup", { email, password })
    await this.set(s)
    return s.user
  }

  async signIn(email: string, password: string) {
    const s = await this.post<Session>("/signin", { email, password })
    await this.set(s)
    return s.user
  }

  async signOut() {
    await this.ready
    const s = this.session
    await this.set(null)
    if (s) await this.post("/signout", { refresh: s.refresh }).catch(() => {})
  }

  async user() {
    await this.ready
    return this.session?.user ?? null
  }

  onChange(f: (u: User | null) => void) {
    this.listeners.add(f)
    this.ready.then(() => f(this.session?.user ?? null))
    return () => {
      this.listeners.delete(f)
    }
  }

  async token(): Promise<string | null> {
    await this.ready
    const s = this.session
    if (!s) return null
    if (expiry(s.access) - Date.now() > 30000) return s.access
    this.pending ??= this.post<Session>("/refresh", { refresh: s.refresh })
      .then(async (n) => {
        await this.set(n)
        return n
      })
      .catch(async (e) => {
        if (e.status === 401) await this.set(null)
        return null
      })
      .finally(() => {
        this.pending = null
      })
    return (await this.pending)?.access ?? null
  }
}
