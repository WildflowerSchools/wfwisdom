# Wildflower Wisdom: design, and where the migration stands

Written 22 September 2026. Two audiences: someone new picking the project up, and anyone deciding when
Bloomfire can be switched off.

Companion documents:

- [`docs/admin-guide.md`](admin-guide.md) — how to *run* it: curating, re-indexing, rotating keys, and the
  step-by-step for the Connected import. Not repeated here.
- [`CLAUDE.md`](../CLAUDE.md) — how to *change* it: layout, conventions, and the traps.

> Where this document states intent rather than fact — why the app exists, what "done" means — it is
> marked **[assumed]**. Those are the parts to correct first.

## What it is

A knowledge base for Wildflower teacher leaders, built over the content that lives in Connected
(Bloomfire). Four things it does:

- **A map.** Content organized by the job in front of you — find a space, form a board, recruit families
  — rather than by folder. Jobs contain sub-jobs; a resource is *placed* in one or more sub-jobs, one of
  them primary.
- **Search.** Hybrid: an embedding search and a Postgres full-text search, fused, then re-ranked with
  curation and how well the title matches what was typed.
- **Ask.** Questions answered from the library's own content, with citations, plus a staff queue for
  questions worth a human answer.
- **Feedback on drafts.** A teacher leader pastes a draft — a family letter, a handbook, a budget — and
  gets it reviewed against what a strong Ops Guide would expect, per material type.

**[assumed]** The reason for building it rather than reorganizing Bloomfire: Bloomfire organizes by
category and search, and the material is hard to find when you need it for a specific task. Correct this
if the real reason was different — cost, contract, or something else.

## Shape

```
apps/web    React + Vite          the reader and staff interface
apps/api    Express + Drizzle     routes, indexing, search, chat, review, import
packages/db Drizzle schema, migrations, seed
packages/shared  types both sides share
```

Postgres (Neon) holds everything. Vectors are stored as a `real[]` on `item_chunks` and searched in
process (`services/vectors.ts`) rather than by a vector extension — small library, and it keeps the
database ordinary.

Hosted on Replit, deployed from GitHub `main`. Scales to zero when idle, which is why the nightly
re-index also catches up on boot.

## The data model, in the order it matters

**`items`** — one row per resource. `source_kind` is `post`, `series`, `question` (mirrored from
Connected) or `native` (imported, or written here). Everything the indexer knows lives here and **is
rewritten on every index run.**

**`item_meta`** — the staff-owned companion, one row per item, which the indexer never touches:
curation, hidden, stages, pinned position, score, staff note, and the `display_*` overrides for title,
author, description and date. If a field can be wrong in Connected and right here, this is where the
right value lives.

**`jobs` / `subjobs` / `placements`** — the map. `placements` carries `is_primary` (what the map ranks
on and what "most used" reads) and `source` (`model` for a model's guess, `staff` for a person's
decision).

**`taxonomy_retirements`** — records that a deleted job or sub-job is *meant* to be gone, because the
seed would otherwise recreate it on the next deploy.

**`item_chunks`** — text split for embedding. **`signals`** — clicks and helpful votes, which feed
`score`. **`chat_turns`**, **`submissions`**, **`app_feedback`**, **`audit_log`** — the queues and the
record of what changed.

Two rules worth stating plainly, because breaking either is silent:

1. **The indexer owns `items`; staff own `item_meta`.** Correcting `items` directly lasts until the next
   nightly run.
2. **`removed_at` belongs to the indexer** — it means "no longer in Connected", and it is cleared for
   anything still there. Staff hide things with `item_meta.hidden`.

## Where the migration off Connected stands

**Measured against production on 22 September 2026:**

| | |
| --- | --- |
| live items | 814 |
| still mirrored from Connected | **814** |
| imported to native | **0** |
| import errors | 0 |
| `connectedSyncEnabled` | `true` |

**Nothing has been imported yet.** The machinery is built, has a dry run and a test-5 mode, and has
never been run for real. So today Wisdom is a *view onto* Bloomfire, not a replacement for it: turn
Bloomfire off now and the library empties on the next index.

### What the import does

`services/import-connected.ts`. Each item keeps its id, so placements, curation, votes and scores
survive. Files go to a per-item folder in the Wisdom Drive; Office files become Google Docs, Slides and
Sheets; PDFs, images, audio and video stay files. A post with real text of its own becomes a Google Doc;
a post that is mostly one document points at that document; anything else keeps its short text as an
intro above its files. Series become native series over the imported posts; questions keep the question
and its answers as a page.

It is resumable — an item is skipped once `imported_at` is set, and files already uploaded for a failed
item are reused. **When nothing is left, it switches `connectedSyncEnabled` off by itself.**

The operating procedure is in [`docs/admin-guide.md` § Moving off Connected](admin-guide.md#moving-off-connected),
including the important practical note that the full run (~12 GB) should be done from the Replit
workspace shell rather than the published app, which scales down when idle.

### What has to be true before Bloomfire is decommissioned

Evidence-based, from the code and the data:

1. **Every item imported** — `imported_from` set on all 814, `import_error` null. The Move off Connected
   page lists failures with reasons; that list has to be empty or each failure consciously accepted.
2. **`connectedSyncEnabled` is off**, which the import does once nothing is left.
3. **Drive holds the files, and the Drive is owned durably.** After the cutover the Wisdom Drive folder
   *is* the library. It needs to survive any one person leaving, and it needs a backup story — there
   isn't one written down today.
4. **Old Connected links still resolve.** There is a redirect path (`map.ts` resolves a Connected
   `kind`/`sourceId` to the item that replaced it), so links inside imported content keep working. Worth
   testing with real links before the source is gone.
5. **A re-index is run**, so the import-time cleanups (bold from Google's stylesheet, opaque file names
   in captions, `SERIES:` prefixes) reach everything. See "Known gaps" below.

**[assumed]** Who decides it is done, and whether anything has to happen inside Bloomfire itself
(exports, notice, contract end date) is not recorded anywhere in this repo.

## Ownership and credentials

The app reads 22 environment variables. These are the ones that are credentials to something outside
Replit — the account behind each needs to be reachable by more than one person, which is a different
question from whether the secret is in the shared Replit workspace.

| variable(s) | system | notes |
| --- | --- | --- |
| `DATABASE_URL`, `IMPORT_DATABASE_URL` | Neon Postgres | the whole library; `IMPORT_*` is a temporary workspace secret for the bulk import, removed afterwards |
| `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_IMPERSONATE_EMAIL`, `GOOGLE_SHARED_DRIVE_ID` | Google Cloud + Workspace | domain-wide delegation: a security decision, not only an access one. After the cutover this Drive holds the content. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud | sign-in |
| `OPENAI_API_KEY` | OpenAI | embeddings, chat, review, drafting; carries the spend |
| `BLOOMFIRE_API_KEY`, `BLOOMFIRE_BASE_URL`, `BLOOMFIRE_LOGIN_EMAIL` | Bloomfire | needed until the cutover completes, not after |
| `RESEND_API_KEY`, `MAIL_FROM` | Resend | outbound mail |
| `SESSION_SECRET` | — | rotating it signs everyone out |

The rest (`APP_BASE_URL`, `PORT`, `NODE_ENV`, `LOG_LEVEL`, `DEV_LOGIN_ENABLED`, `REPLIT_*`) are
configuration, not secrets. Rotation steps are in
[`docs/admin-guide.md` § Secrets and how to rotate keys](admin-guide.md#secrets-and-how-to-rotate-keys),
and `node scripts/check-secrets.mjs` checks the Drive ones.

Code lives at `WildflowerSchools/wfwisdom` on GitHub. It was moved there from the personal account
`matthewlkramer/wfwisdom` in November 2026; the old address redirects for reads, but a tool given
access to the repo only under its new name is refused a push to the old one, so point remotes at the new.

## Known gaps

- **No re-index has been run since several import-time fixes landed.** Bold that Google expresses as a
  stylesheet class, opaque base64 file names in captions and alt text, and `SERIES:` title prefixes are
  all fixed *as items are brought in*. Items already stored keep the old rendering until a re-index. The
  fixes are live; the backfill is not.
- **Six Self-Management modules are not children of their parent series** in the data, so they sit beside
  it rather than inside it. Nothing in the code can infer the relationship; someone has to create it.
- **One roster still names an archived item.** "Admissions & Enrollment Contracts and Forms" lists the
  Acuerdo de Matrícula post that was archived as a duplicate — resolved for now by swapping which of the
  two identical posts is visible, but the underlying duplication is still in Connected.
- **No branch protection** on `main`, and the Claude GitHub App is installed for a personal account.
- **No backup story for the Wisdom Drive folder**, which becomes the library after the cutover.
