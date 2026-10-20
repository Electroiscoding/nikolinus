# Nikolinus

Nikolinus is three small Bun services over one Postgres, with one JSONB document table, one driver and no ORM. The root holds only `authentication/`, `database/` and `functions/`.

## Project structure

```
nikolinus/
├── authentication/
│   ├── client/
│   │   └── index.ts
│   ├── src/
│   │   ├── core.ts
│   │   └── server.ts
│   ├── .env
│   ├── package.json
│   └── tsconfig.json
├── database/
│   ├── client/
│   │   └── index.ts
│   ├── src/
│   │   ├── core.ts
│   │   ├── query.ts
│   │   └── server.ts
│   ├── .env
│   ├── package.json
│   └── tsconfig.json
└── functions/
    ├── client/
    │   └── index.ts
    ├── src/
    │   ├── handlers/
    │   │   ├── count.ts
    │   │   └── hello.ts
    │   ├── core.ts
    │   └── server.ts
    ├── .env
    ├── package.json
    └── tsconfig.json
```

Ports are 4001 for authentication, 4002 for database and 4003 for functions.

## Install

```bash
sudo apt update && sudo apt install -y postgresql curl unzip jq
curl -fsSL https://bun.sh/install | bash
exec $SHELL
sudo -u postgres psql -c "create role nikolinus login password 'CHANGE_ME'" -c "create database nikolinus owner nikolinus"
```

Scaffold the folders and the `.env` files:

```bash
mkdir -p nikolinus/{authentication,database,functions}/{src,client} nikolinus/functions/src/handlers
cd nikolinus
S=$(openssl rand -hex 32); K=$(openssl rand -hex 32)
for d in authentication database functions; do
  printf "DATABASE_URL=postgres://nikolinus:CHANGE_ME@127.0.0.1:5432/nikolinus\nJWT_SECRET=$S\nSERVICE_KEY=$K\n" > $d/.env
done
```

## Run

```bash
for d in authentication database functions; do (cd $d && bun install); done
(cd authentication && bun run start) &
(cd database && bun run start) &
(cd functions && bun run start) &
```

Smoke test:

```bash
A=http://localhost:4001 D=http://localhost:4002 F=http://localhost:4003
H='content-type: application/json'
T=$(curl -s $A/signup -H "$H" -d '{"email":"a@b.co","password":"password123"}' | jq -r .access)
curl -s $D/doc/todos -H "$H" -H "authorization: Bearer $T" -d '{"title":"ship","done":false}'
curl -s $D/query -H "$H" -H "authorization: Bearer $T" -d '{"collection":"todos","where":[["done","==",false]]}'
curl -s $F/call/hello -H "$H" -d '{"data":{"name":"x"}}'
curl -s $F/call/count -H "$H" -H "authorization: Bearer $T" -d '{"data":{"collection":"todos"}}'
```

Access rules per collection are admin-set. The values for `read` and `write` are `public`, `auth`, `owner` (the default) and `none`:

```bash
curl -X PUT $D/rules/posts -H "$H" -H "x-service-key: $(grep SERVICE_KEY database/.env | cut -d= -f2)" -d '{"read":"public","write":"owner"}'
```

## Use (web, React Native, Node, Bun)

```ts
import { Auth } from "./authentication/client"
import { Database } from "./database/client"
import { Functions } from "./functions/client"

const base = "https://api.yourcloud.com"
const auth = new Auth(`${base}/authentication`)
const db = new Database(`${base}/database`, auth)
const fn = new Functions(`${base}/functions`, auth)

await auth.signUp("a@b.co", "password123")

const todo = await db.collection("todos").add({ title: "ship", done: false })
await db.collection("todos").doc(todo.id).update({ done: true })

const stop = db
  .collection("todos")
  .where("done", "==", false)
  .orderBy("created_at", "desc")
  .limit(20)
  .onSnapshot((docs) => console.log(docs))

console.log(await fn.call("hello", { name: "world" }))
```

For backend use, pass the service key as the third argument, for example `new Database(url, undefined, { "x-service-key": KEY })`, and the same code bypasses collection rules.

Run `bun run build:client` in each folder to get a minified browser bundle in `dist/`.

**Android, iOS and any other language:** the API is plain HTTP and JSON, so any HTTP client works.
- **Auth:** `POST /signup`, `/signin`, `/refresh`, `/signout`, and `GET /me`. Send `Authorization: Bearer <access>` on other calls.
- **Database:** `POST /doc/:c`, `PUT`, `PATCH`, `GET` and `DELETE /doc/:c/:id`, `POST /query`, and `POST /watch` (server-sent events).
- **Functions:** `POST /call/:name` with the body `{"data": ...}`.

## Deploy as a cloud

One domain in front keeps everything on the same origin. CORS is also open on every service, so it works without the proxy too.

```bash
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'CADDY_EOF'
api.yourcloud.com {
  handle_path /authentication/* { reverse_proxy 127.0.0.1:4001 }
  handle_path /database/* { reverse_proxy 127.0.0.1:4002 { flush_interval -1 } }
  handle_path /functions/* { reverse_proxy 127.0.0.1:4003 }
}
CADDY_EOF
sudo systemctl reload caddy
```

Keep the services running with systemd:

```bash
sudo cp ~/.bun/bin/bun /usr/local/bin/bun
sudo useradd -r -d /opt/nikolinus nikolinus
sudo cp -r ../nikolinus /opt/ && sudo chown -R nikolinus /opt/nikolinus
sudo tee /etc/systemd/system/nikolinus@.service >/dev/null <<'SYSTEMD_EOF'
[Unit]
After=network.target postgresql.service

[Service]
User=nikolinus
WorkingDirectory=/opt/nikolinus/%i
ExecStart=/usr/local/bin/bun src/server.ts
Restart=always

[Install]
WantedBy=multi-user.target
SYSTEMD_EOF
sudo systemctl enable --now nikolinus@authentication nikolinus@database nikolinus@functions
```

## Before real customers

- **Multi-tenant:** the only tenant setting is `DATABASE_URL`, so run one stack per customer with its own Postgres database, `JWT_SECRET` and ports.
- **Brute force:** add rate limiting on `/signin` and `/signup` at the proxy.
- **Not included:** email verification, password reset and OAuth providers.
- **Realtime:** `LISTEN/NOTIFY` needs a direct Postgres connection, so a PgBouncer in front must use session mode.
