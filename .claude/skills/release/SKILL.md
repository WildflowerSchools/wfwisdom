---
name: release
description: Get a merged change from GitHub main onto https://mywildflower.replit.app. Use whenever asked to deploy, publish, ship, release or push changes live, and for any change that adds a database migration. Covers the publish review gate that can propose destructive migrations, and the verification that a deploy actually landed.
---

# Releasing Wildflower Wisdom

GitHub `main` is the source of truth. Replit holds a workspace that syncs from it and a deployment that
serves `mywildflower.replit.app`. A release is: merge, sync the workspace, publish, verify.

Everything below exists because it went wrong once. The migration step in particular: skipping it
produced a proposal to `DROP TABLE "taxonomy_retirements" CASCADE` against production, with data in it.

## Before merging

Run the deploy's own build and read the exit codes **directly**, not through a pipe:

```
pnpm build; echo "exit=$?"
pnpm test;  echo "exit=$?"
```

`pnpm build | tail` reports `tail`'s exit code, which is always 0. A publish once failed on a type error
that a piped check had reported as clean. And `pnpm test` runs vitest, which does not typecheck the
project — green tests are not a green build.

Note the bundle hash the build prints (`dist/assets/index-XXXXXXXX.js`). It is how you will confirm the
deploy landed.

## 1. Merge

Open the PR against `main` and merge it. The merge tool wants the **full 40-character head SHA** — get it
rather than padding a short hash, which fails with "Head branch was modified".

## 2. Sync the workspace

Ask the Replit workspace to fetch and move to the merge commit. Say explicitly:

- the commit to move to,
- whether the change contains migrations,
- **not to publish** — you will do that separately.

Give it a couple of minutes. Confirm it landed by reading a file you changed, not by assuming.

> The Replit file tools do not surface `.sql` files. A migration can be present and invisible to them —
> check `packages/db/migrations/meta/_journal.json`, which they do read, instead of concluding the file
> is missing.

## 3. If the change adds a migration, apply it to the development database first

**This is the step that matters.** Do it before publishing.

Ask the workspace to run the repo's own migration script against the **development** database —
explicitly *not* `drizzle-kit push`, and not to generate a new migration.

Why: the publish review compares the workspace's development database against production and proposes
a migration to make production match. The direction decides what it proposes.

| state | what the review proposes |
| --- | --- |
| production ahead of dev | **`DROP`** whatever production has and dev lacks — destructive |
| dev ahead of production | `ADD COLUMN` / `CREATE TABLE` — additive, safe |
| identical | nothing, and the publish goes straight through from chat |

Applying the migration to dev first puts you in the safe row.

## 4. Publish

Call publish. Two outcomes:

**It starts.** Good — the databases agreed and there was nothing to review.

**It refuses**, saying the schema changed and the review is only available on the Replit website. This is
expected whenever the release adds a migration. Tell the person:

- to open the app on Replit and publish from there,
- exactly what the review should show — list the specific `ADD COLUMN` / `CREATE TABLE` statements,
- that **any `DROP`, any column being altered, or the orange "may permanently remove some data" banner
  means stop and report back**, not approve.

Confirm the expected diff yourself first, by querying both sides, so the description you give is exact
rather than reassuring.

Do not try to pre-apply the schema change to production by hand to dodge the gate. It is a production
schema change and will be refused, correctly.

## 5. Verify

Not optional — one publish in this repo's history reported `pending` and then failed at build.

1. Poll publish status until it settles. `success`, not "no error yet".
2. Fetch the live page and compare its bundle hash to the one your build printed. Equal means the
   deployed code is your code. If the release only touched the API, the hash will not change — read a
   marker string out of the served bundle instead, or check behaviour directly.
3. If the release included a migration, query production and confirm the new columns or tables exist and
   the migration count went up.
4. If it included a data change, read it back through the same expression the app reads it through —
   the `coalesce` of an override, not the raw column.

## If the publish fails

Reproduce the failure locally before touching anything. `pnpm build` with its real exit code has caught
every failure so far. Fix, re-verify, merge, and run the sequence again — a failed publish leaves the
previous version serving, so there is no urgency and no reason to guess.

## After a release that changes the taxonomy seed

Every deploy runs `db:migrate && db:seed`. The seed recreates any job or sub-job in
`seed-taxonomy.json` that does not exist. If staff deleted or merged one, it comes back empty unless
`taxonomy_retirements` records the retirement. Check that table if a deleted sub-job reappears.
