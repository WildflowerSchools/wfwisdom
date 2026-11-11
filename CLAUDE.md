# Working on Wildflower Wisdom

This file is for whoever is changing the code, human or Claude. It covers the shape of the app, the
handful of things that reliably surprise people, and how to get a change safely to production.

For running the app as an administrator — curating, re-indexing, rotating keys, the Connected import —
see [`docs/admin-guide.md`](docs/admin-guide.md). For what the app is and where the migration off
Connected stands, see [`docs/wfwisdom.md`](docs/wfwisdom.md).

## Layout

A pnpm workspace, Node 22:

| package | what it is |
| --- | --- |
| `apps/api` | Express, Drizzle. Routes in `src/routes`, the work in `src/services`. |
| `apps/web` | React, Vite, TanStack Query, react-router. |
| `packages/db` | Drizzle schema, migrations, seed. Exports the tables everything else imports. |
| `packages/shared` | Types and constants both sides need (regions, document types, stages). |

Commands, all from the root: `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm typecheck`,
`pnpm db:migrate`, `pnpm db:seed`.

`.replit` runs `pnpm preview` in the workspace and `pnpm deploy:start` in the deployment, which is
`db:migrate && db:seed && start` — so **every deploy migrates and seeds.** Keep both idempotent.

## The six things that surprise people

### 1. The indexer owns most of an item; staff overrides live beside it

`runReindex` writes `items` from Connected on **every run**, with `onConflictDoUpdate`. So editing
`items.title`, `items.author_name`, `items.description` or `items.published_at` directly — in SQL or in
code — is silently undone the next night.

Anything staff set goes in `item_meta`, which the indexer never touches:

| column | replaces |
| --- | --- |
| `display_title` | `items.title` |
| `display_author` | `items.author_name` |
| `display_description` | `items.description` — **empty string means show none**, null means fall back |
| `display_published_at` | `items.published_at` |

Reads go through `titleExpr` in `apps/api/src/services/items.ts` and the coalesces in `itemSelect`. If
you add a place that renders a title, author, date or description, use those rather than the raw column.

`items.fts` is a **generated** column built from `items.title`/`description`/`body_text`, so an override
is not in the full-text index. Search compensates by matching the override separately; see
`apps/api/src/services/search.ts`.

### 2. Cards and placements are different numbers, deliberately

A post belonging to a series is shown *inside* the series card, not beside it. So:

- **`subjobItemCounts`** counts cards — what a reader sees. The map uses it.
- **`subjobPlacementCounts`** counts placement rows — what staff can drag, remove or merge. Organize uses it.

They disagree for most sub-jobs (5 against 35 on "501c3 status and the group exemption"). Both are
correct for what they answer. If you are showing a number, decide which question you are answering.

### 3. The seed recreates anything you delete, unless it is retired

`pnpm db:seed` inserts every job and sub-job in `packages/db/seed-taxonomy.json` and skips ones that
already exist. Deleting a sub-job therefore left nothing to collide with and it came back on the next
deploy, empty. `taxonomy_retirements` records that an absence is deliberate and the seed skips those
keys; creating one with the same key again clears the record. The admin routes do this for you — use
them rather than deleting rows.

### 4. Visibility and the reader's filters are two separate gates

`visibleWhere(staff)` decides what exists for this viewer: `removed_at is null`, `status = 'published'`,
and for non-staff also not hidden. `filterWhere(f)` applies the reader's language, region and type
choices. Nearly every list needs both, and the region filter means *only* what was ticked — ticking
Minnesota shows Minnesota's material and nothing else, and "not region-specific" is its own tick.

`removed_at` is the indexer's own flag for "gone from Connected" and it is cleared on every run for
anything still there. To take something out of circulation use `item_meta.hidden`, which is staff's.

### 5. Series nest, and the nesting rules have to agree in three places

`nestSeries` decides what is a card and what is nested inside one. `subjobItemCounts` mirrors that logic
in SQL, and `postsBySourceId` resolves a series' children. If you change one, change all three, or the
count beside a job stops matching the cards under it.

### 6. A native resource is edited in exactly one place

`native_kind = 'google'` is *linked*: the Google file is the resource, and `body_html`/`body_text` are a
copy Wisdom re-reads (`refreshNativeItem`) nightly and when the resource is opened (`refreshOnOpen`).
`'text'` and `'file'` are *held*: the Wisdom record is the resource. Do not add a way to edit a linked
resource's body here, or a held page that also follows a Google file: one editable copy each is the
rule the two kinds exist to keep. `detachToHeld` and `toGoogleDoc` move a resource between them.

A held page is Markdown. `lib/markdown.ts` writes it from a Google Doc and `markdownToHtml` reads it;
change one and the other has to follow, or a document that came in stops rendering as it arrived.

## The Claude connector

`apps/api/src/mcp` serves Wisdom to Claude as an MCP server at `/mcp`, with Wisdom as its own OAuth
server; see [`docs/connector.md`](docs/connector.md). Three things to keep true when changing it:

- **Tools call the services, never the tables directly for anything a service already answers.** That is
  what keeps a connector user seeing exactly what a web user sees.
- **It is mounted before CORS and the per-address rate limit on purpose.** Every request comes from
  Anthropic's servers, so a per-address limit treats the whole network as one reader.
- **A tool's name and arguments are an interface.** The skills and the published map page call them by
  name; renaming one breaks both without a type error anywhere.

## Conventions

- **Comments say why, not what.** Most of the comments in this repo record a decision or a trap; a
  comment restating the code is noise. If a line looks wrong but is right, say why there.
- **Commit messages carry the reasoning**, including what was tried and rejected. They are the main
  record of why the code is the way it is.
- Match the surrounding style: dense, few blank lines, early returns.

## Before you push

Run the deploy's own build and **check its exit code directly**:

```
pnpm build; echo "exit=$?"
pnpm test;  echo "exit=$?"
```

Do not pipe it. `pnpm build | tail` reports the exit code of `tail`, which is always 0 — a broken build
reported success that way and the deploy failed on a type error that was visible locally the whole time.

`pnpm test` runs vitest, which does **not** typecheck the project, so passing tests are not evidence the
build is clean. Both, every time.

## Getting it live

Merge to `main`, sync the Replit workspace, publish. The sequence has real traps — one of them proposed
dropping a table with data in it — so follow [`.claude/skills/release`](.claude/skills/release/SKILL.md)
rather than improvising. The short version:

1. Merge the PR into `main`.
2. Sync the Replit workspace to the merge commit.
3. **If the change adds a migration, apply it to the Replit development database before publishing.**
4. Publish, then verify the live bundle hash matches the one your build produced.

## Production

Neon Postgres, reached from the app by `DATABASE_URL`. Raw 5432 is blocked from some sandboxes; Neon's
HTTPS `/sql` endpoint works where psql hangs. Direct writes to production are sometimes the right tool
(a data correction that no admin screen covers) — when you make one, write an `audit_log` row saying who
asked, what changed and how to undo it, and keep whatever you need to reverse it.
