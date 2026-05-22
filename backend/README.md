# mapy-for-chrome-backend

Cloudflare Worker + D1 backend for sharing Mapy for Chrome routes between users.

## One-time setup

```powershell
cd C:\Users\honza\mapy-for-chrome\backend
npm install
npx wrangler login        # opens a browser to authorize wrangler with Cloudflare

# Create the D1 database. Copy the printed database_id into wrangler.toml.
npm run db:create

# Apply the schema to the remote D1 instance.
npm run db:migrate:remote

# Deploy the worker.
npm run deploy
```

`wrangler deploy` prints the deployed URL (typically
`https://mapy-for-chrome-backend.<your-subdomain>.workers.dev`). Set that as
`VITE_BACKEND_URL` in the extension's `.env.local` and rebuild.

## Local dev

```powershell
npm run db:migrate:local   # apply schema to the local D1 emulator
npm run dev                # starts wrangler dev at http://127.0.0.1:8787
```

## API

```
GET  /v1/routes?since=<unix_ts>    List shared routes (public). Pass `since`
                                   to filter by `updated_at`.
POST /v1/routes                    Upload/update a shared route (auth required).
                                   Body is the full route JSON (see schema.sql).
DELETE /v1/routes/:id              Delete a shared route (auth, owner only).
```

Auth: `Authorization: Bearer <Seznam access token>`. The worker calls
`https://login.szn.cz/api/v1/user` to verify and caches results for 15 minutes.
