# The Claude connector

Written 11 November 2026. Wisdom can be used from inside Claude: a teacher leader connects "Wildflower
Wisdom" once, and Claude can then search the library, read resources, browse the map, review a draft
against the guidance for its type, and send questions and contributions to Foundation staff. The web app
keeps working alongside it; the admin pages are still where taxonomy and contributions are managed.

The code is in `apps/api/src/mcp`. This document is how to run it.

## What moved and what stayed

Claude now does what the app used a model for: writing the answer, reviewing the draft, holding the
conversation. Everything else stays on this side and goes through the same services as the web app, so a
person sees through Claude exactly what they would see on the site: `visibleWhere`, their language and
region filters, staff-only jobs.

| tool | what it does |
| --- | --- |
| `search_wisdom` | hybrid search plus the most relevant passages; requires the asker's question in their own words |
| `get_resource` | one resource in full, in parts if long; counts as a click for ranking |
| `browse_map` | jobs and sub-jobs with counts, or the resources in one sub-job |
| `whats_new` | recently updated, start-here for a stage, most used |
| `my_profile`, `set_my_stage` | who is connected and their stage |
| `list_review_types`, `get_review_guide` | the base prompt, guide, objectives and recommended resources for a material type |
| `log_question` | records a question and its outcome; optionally sends it to the staff queue |
| `rate_resource`, `share_resource` | a helpful vote; a Google file offered to the library |
| `staff_*` | staff only: questions queue, gap report, curation, placement, pending contributions |

A teacher leader's connection does not carry the staff tools at all.

## Turning it on

1. Deploy as usual ([`.claude/skills/release`](../.claude/skills/release/SKILL.md)). Migration `0013_connector`
   adds four tables and three columns and changes nothing existing.
2. Check `https://wfwisdom.replit.app/.well-known/oauth-authorization-server` returns JSON. The addresses
   in it come from `APP_BASE_URL`, so that has to be the public https address.
3. In Claude, add a custom connector named **Wildflower Wisdom** with the address
   `https://wfwisdom.replit.app/mcp`. The name matters: the map page asks for a connector by that name.
   For the whole network, an organization owner adds it once for everyone.
4. Connect. You are sent to Wisdom, sign in with Google if you are not already, and approve.

No new secrets. Sign-in is the web app's Google sign-in; Wisdom issues its own tokens to Claude (an hour,
renewed for up to ninety days) and stores only their hashes.

## What staff can see

- **Every search** is in `search_log` with the asker's own words in `question` and `source = 'connector'`
  (`'map'` for the map page's search box).
- **Every question Claude reports** is a `chat_turns` row with `source = 'connector'`: whether the library
  answered it, what was cited, a summary of what the person was told. Ones sent to staff appear in the
  existing Questions queue.
- **Every tool call** is in `mcp_calls`: who, which tool, small keys. Never a draft, never an answer.
- `staff_gap_report` in Claude pulls these together: questions not answered, searches that found nothing,
  most-cited resources, tool use.

Two limits to be honest about. A question is recorded only if Claude calls `log_question`; the skills and
the connector's own instructions tell it to, but it is not enforced. And drafts sent for review never
reach Wisdom, so there is no record of reviews beyond the `get_review_guide` call.

Tell teacher leaders their questions are recorded.

## Removing someone's access

Deleting their rows from `mcp_tokens` signs their connectors out (`revokeConnectorAccess` in
`mcp/oauth.ts`). Their web session is separate.

## The map page

`tools/map-page` holds the source of the map published as a Claude artifact. It reads live through the
connector (`browse_map`, `whats_new`, `search_wisdom`) and falls back to a snapshot built from
`packages/db/seed-*.json` and `docs/stage1/mapping.csv` when the connector is not connected.
`python3 build.py <repo root>` from that folder writes `index.html`.

## Not built

- Approving a contribution from Claude. It needs placement and stages; use the Contributions page.
- Uploading a file as a contribution. Only Google links.
- Any message pushed to people. Claude speaks only when someone opens a conversation; a digest would be
  email, using the scheduler and Resend that are already here.
