# Wildflower Wisdom

A site that helps emerging Wildflower school teams find and use Connected (the Wildflower knowledge base) and get AI feedback on the materials they write. Published at https://mywildflower.replit.app.

- `apps/api` — Express API: Google sign-in, the Connected indexer, search and chat, draft reviews, admin.
- `apps/web` — React + Vite app: teacher-leader pages (start here, map, search, ask, get feedback) and the staff workspace.
- `packages/db` — Drizzle schema, migrations, and idempotent seed data (taxonomy, placements, material types, base prompt).
- `packages/shared` — types shared by API and web.
- `docs/admin-guide.md` — how to run it. `docs/stage1/` — the content audit and proposals behind the design.

GitHub `main` is the source of truth; Replit hosts and publishes. See `docs/admin-guide.md` for setup, secrets, re-indexing, curation, material types, prompts, the submission log, and key rotation.

## Local development

```
pnpm install
cp .env.example .env            # fill in DATABASE_URL and the secrets you have
pnpm db:migrate && pnpm db:seed
pnpm index                      # pulls Connected (needs BLOOMFIRE_* and OPENAI_API_KEY)
pnpm dev                        # API on :8080, web on :5173
```

Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before merging to `main`. `node scripts/check-secrets.mjs` verifies every secret against its service. `node scripts/browser-check.mjs <url> --dev-login --submit` walks every flow in a browser (dev login works only with `DEV_LOGIN_ENABLED=1` outside production).
