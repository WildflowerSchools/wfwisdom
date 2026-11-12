import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { and, asc, auditLog, chatTurnNotes, chatTurns, desc, eq, getDb, gt, inArray, itemMeta, items, jobs, materialTypes, mcpCalls, placements, searchLog, signals, sql, subjobs, typeResources, users } from "@wfw/db";
import { DOC_TYPES, STAGES, type ItemSummary, type SessionUser, type StageKey } from "@wfw/shared";
import { env } from "../env.js";
import { dropDuplicateByline, mergeAdjacentLists, stripContentTokens } from "../lib/html.js";
import { logger } from "../logger.js";
import { approveContribution, createNativeItem, declineContribution, detachToHeld, freshenBriefly, setPlacements, toGoogleDoc } from "../routes/native.js";
import { CurationError, applyMetaPatch, moveItem } from "../services/curation.js";
import { RESOURCE_LIST, filterWhere, itemSelect, itemsByIds, itemsForSubjob, mostUsed, postsBySourceId, startHere, subjobItemCounts, toSummary, visibleWhere, type ItemRow } from "../services/items.js";
import { googleKindOfMime, googleUrl, isGoogleAppsMime } from "../services/native.js";
import { addNote, getStaffQuestion, listStaffQuestions, updateQuestion } from "../services/questions.js";
import { currentBasePrompt } from "../services/review.js";
import { schoolContext } from "../services/school.js";
import { retrievePassages, search } from "../services/search.js";
import { recordSignal } from "../services/signals.js";
import { getSettings } from "../settings.js";
import { connectedUserCount } from "./oauth.js";
import { createUploadLink } from "./upload.js";

/**
 * The tools Claude is given when someone connects Wildflower Wisdom.
 *
 * What moved to Claude and what stayed here: Claude writes the answer, reviews the draft and holds the
 * conversation, which is what the Ask page and the review service used a model for. Everything that
 * makes the library the library stays on this side — which resources exist for this person, how they
 * rank, where they sit on the map, the guidance staff wrote for each material type — and every tool
 * goes through the same services the web app does, so a teacher leader sees through Claude exactly what
 * they would see on the site.
 *
 * Two things here exist only because the Ask page is no longer in the loop. `search_wisdom` requires
 * the person's question in their own words, so the log still shows what people came for rather than
 * the search terms Claude chose. And `log_question` is how an answer Claude gave gets back to staff:
 * whether the library covered it, and what it cited. Without those the content-gap picture goes dark.
 */
export const SERVER_INSTRUCTIONS = `Wildflower Wisdom is the Wildflower Schools network's library of guides, templates, examples and policies for teacher leaders who are starting or running a school.

Answering a question:
- Call search_wisdom first, passing the person's question in their own words as "question". Add "search_words" when better search terms would help.
- Answer only from what the library returns. Read a resource with get_resource before relying on details that the search passages do not show.
- Name each resource you relied on and give its link. Never state a Wildflower policy, number or requirement the library did not give you.
- If the library does not cover the question, say so plainly and offer to send it to Foundation staff.
- When you have answered, or found that you cannot, call log_question once with whether the library answered it and which resources you cited.

Other things people do here: browse the library by the job in front of them (browse_map), see what is new (whats_new), get a draft reviewed against Wildflower's guidance for that kind of document (list_review_types, then get_review_guide), add a resource of their own (create_resource for text written here, share_resource for a Google file, request_upload_link for a file on their device), and say whether a resource helped (rate_resource).

Tools whose names start with staff_ appear only for Foundation staff. They change what teacher leaders see: say what you are about to change and get a yes before calling one.`;

const base = () => env.appBaseUrl;
const link = (id: string) => `${base()}/item/${id}`;
const typeOf = (s: ItemSummary) => s.contentType === RESOURCE_LIST ? RESOURCE_LIST : s.isSeries ? "series" : s.kind === "question" ? "question" : s.contentType ?? "other";
const brief = (s: ItemSummary) => ({
  id: s.id, title: s.title, ...(s.author ? { author: s.author } : {}), type: typeOf(s), summary: s.summary ?? s.description, updated: s.updatedAt?.slice(0, 10) ?? null,
  curation: s.curation, dated: s.dated, language: s.language, regions: s.regions, link: link(s.id),
  ...(s.why ? { why_here: s.why } : {}), ...(s.children?.length ? { contains: s.children.map((c) => ({ id: c.id, title: c.title })) } : {}),
});
const isStage = (s: unknown): s is StageKey => typeof s === "string" && STAGES.some((x) => x.key === s);
const TYPE_KEYS = DOC_TYPES.map((t) => t.key) as [string, ...string[]];

/**
 * A resource's formatted body, for a reader that is not the web app.
 *
 * The stored HTML is written for the site: a link to another Connected post is `/c/post/123`, which the
 * site resolves as it navigates, and files are `/api/files/…`. Outside the site those go nowhere. So
 * links to other resources become `/item/<id>` on the site's own address, which a reader can recognize
 * and open in place, and everything else that was relative becomes absolute. A reference to something
 * this person cannot see is pointed back at Connected, where it came from, not at a Wisdom page that
 * would refuse them.
 */
async function readerHtml(html: string, author: string | null, staff: boolean): Promise<string> {
  let out = dropDuplicateByline(mergeAdjacentLists(stripContentTokens(html)), author);
  const refs = [...new Set([...out.matchAll(/href="\/c\/(post|series|question)\/(\d+)"/g)].map((m) => `${m[1]}/${m[2]}`))].slice(0, 60);
  const found = new Map<string, string>();
  await Promise.all(refs.map(async (ref) => {
    const [kind, n] = ref.split("/") as [string, string];
    const [r] = await getDb().select({ id: items.id }).from(items).leftJoin(itemMeta, eq(itemMeta.itemId, items.id)).where(and(sql`(${items.sourceKind} = ${kind} and ${items.sourceId} = ${Number(n)}) or ${items.importedFrom} @> ${JSON.stringify({ kind, sourceId: Number(n) })}::jsonb`, visibleWhere(staff))).limit(1);
    if (r) found.set(ref, r.id);
  }));
  out = out.replace(/href="\/c\/(post|series|question)\/(\d+)"/g, (_m, kind: string, n: string) => {
    const id = found.get(`${kind}/${n}`);
    return `href="${id ? link(id) : `https://connected.wildflowerschools.org/${kind === "post" ? "posts" : kind === "series" ? "series" : "questions"}/${n}`}"`;
  });
  return out.replace(/\b(href|src)="\/(?!\/)/g, `$1="${base()}/`);
}

type Outcome = { data: Record<string, unknown>; detail?: Record<string, unknown> };
class ToolError extends Error {}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export function buildServer(user: SessionUser): McpServer {
  const staff = user.role === "staff";
  const actor = `${user.name} <${user.email}>`;
  const reader = { language: user.resourceLanguage, regions: user.resourceRegions };
  const server = new McpServer({ name: "wildflower-wisdom", title: "Wildflower Wisdom", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });

  /** Runs a tool, records that it ran, and turns a thrown error into a reply Claude can read and act on. */
  const run = <A>(name: string, fn: (a: A) => Promise<Outcome>) => async (a: A): Promise<CallToolResult> => {
    const record = (ok: boolean, detail: Record<string, unknown>) => getDb().insert(mcpCalls).values({ userId: user.id, tool: name, detail, ok }).catch((e: Error) => logger.warn({ err: e.message, tool: name }, "connector call log failed"));
    try {
      const { data, detail } = await fn(a);
      await record(true, detail ?? {});
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
    } catch (e) {
      const expected = e instanceof ToolError || e instanceof CurationError;
      if (!expected) logger.error({ err: (e as Error).message, tool: name }, "connector tool failed");
      await record(false, { error: (e as Error).message.slice(0, 200) });
      return { isError: true, content: [{ type: "text", text: expected ? (e as Error).message : "Wildflower Wisdom could not do that just now. Try again in a moment." }] };
    }
  };

  // ---- finding and reading

  server.registerTool("search_wisdom", {
    title: "Search the library",
    description: "Search Wildflower Wisdom. Returns the best-matching resources and the passages from them most relevant to the question. Always pass the person's question in their own words; it is recorded so Foundation staff can see what teacher leaders are looking for.",
    inputSchema: {
      question: z.string().trim().min(2).max(1500).describe("The person's question or request, in their own words, not rewritten."),
      search_words: z.string().trim().max(300).optional().describe("Search terms to use instead of the question, when shorter or different words will match better."),
      types: z.array(z.enum(TYPE_KEYS)).max(13).optional().describe("Only return these kinds of resource."),
      limit: z.number().int().min(1).max(15).optional().describe("How many resources to return. Default 8."),
      job_key: z.string().max(80).optional().describe("A job key from browse_map, when the question clearly belongs to one job. Resources in that job rank a little higher."),
      source: z.enum(["chat", "map"]).optional().describe("Leave unset. The map page sets this for its filter box."),
    },
    annotations: READ,
  }, run("search_wisdom", async (a) => {
    const q = (a.search_words || a.question).slice(0, 300);
    const want = a.limit ?? 8;
    // Claude chose these words, so the model that would rewrite them for the web app's search box is skipped.
    const r = await search(q, { staff, limit: a.types?.length ? 30 : want, userId: user.id, ...reader, rewrite: false, jobKey: a.job_key ?? null });
    let results = r.results;
    if (a.types?.length) { const ct = new Set(a.types); results = results.filter((it) => ct.has(typeOf(it))).slice(0, want); }
    // Passages cost an embedding call, so they follow the same switch staff use to stop model spend.
    const s = await getSettings();
    let passages: { resource_id: string; title: string; link: string; text: string }[] = [];
    if (!s.killSwitch && a.source !== "map") {
      try { passages = (await retrievePassages(q, staff, 6)).map((p) => ({ resource_id: p.itemId, title: p.title, link: link(p.itemId), text: p.text })); }
      catch (e) { logger.warn({ err: (e as Error).message }, "connector passage retrieval failed"); }
    }
    await getDb().insert(searchLog).values({ userId: user.id, query: q, rewritten: r.rewritten, mode: r.mode, resultCount: results.length, question: a.question, source: a.source === "map" ? "map" : "connector" });
    return { data: { results: results.map(brief), passages, note: results.length ? undefined : "Nothing in the library matched. Try other words, or tell the person the library does not cover this and offer to send it to Foundation staff." }, detail: { results: results.length } };
  }));

  server.registerTool("get_resource", {
    title: "Read a resource",
    description: "Read one resource in full: its text, files and links, and where it sits on the map. Long resources come in parts; pass offset to read on. In the formatted body, a link to another resource ends in /item/ and that resource's id, which can be passed back to this tool.",
    inputSchema: {
      id: z.string().uuid().describe("The resource id from search_wisdom, browse_map or whats_new."),
      offset: z.number().int().min(0).optional().describe("Character position to start reading from. Default 0."),
      max_chars: z.number().int().min(1000).max(60_000).optional().describe("How much text to return. Default 20000."),
      format: z.enum(["text", "html"]).optional().describe("Leave unset when reading in a conversation. html adds the formatted body, with its headings and links, for a page that displays the resource."),
    },
    annotations: READ,
  }, run("get_resource", async (a) => {
    const db = getDb();
    // Linked to a Google file: pick up an edit made there before reading, as the site does.
    if (!a.offset) await freshenBriefly(a.id);
    const [r] = await db.select({ ...itemSelect, authorName: sql<string | null>`coalesce(${itemMeta.displayAuthor}, ${items.authorName})`, publishedAt: sql<Date | null>`coalesce(${itemMeta.displayPublishedAt}, ${items.publishedAt})`, bodyText: items.bodyText, bodyHtml: items.bodyHtml, sourceKind: items.sourceKind, nativeKind: items.nativeKind, googleKind: items.googleKind, attachmentsFull: items.attachments, linkedDocs: items.linkedDocs, sourceId: items.sourceId, status: items.status, staffNote: itemMeta.staffNote, stages: itemMeta.stages, pinnedStage: itemMeta.pinnedStage, displayTitle: itemMeta.displayTitle, displayDescription: itemMeta.displayDescription })
      .from(items).leftJoin(itemMeta, eq(itemMeta.itemId, items.id)).where(and(eq(items.id, a.id), visibleWhere(staff)));
    if (!r) throw new ToolError("That resource is not in the library, or is not available to this person.");
    const pl = await db.select({ subjob_key: subjobs.key, subjob: subjobs.name, job: jobs.name, primary: placements.isPrimary }).from(placements).innerJoin(subjobs, eq(subjobs.id, placements.subjobId)).innerJoin(jobs, eq(jobs.id, subjobs.jobId)).where(eq(placements.itemId, r.id)).orderBy(desc(placements.isPrimary));
    const [votes] = await db.select({ yes: sql<number>`count(*) filter (where kind='helpful_yes')::int`, no: sql<number>`count(*) filter (where kind='helpful_no')::int` }).from(signals).where(eq(signals.itemId, r.id));
    // A series lists what is inside it: Connected series by post id, series built here by item id.
    const postIds = (r.childPostIds ?? []).slice(0, 100), nativeIds = (r.childItemIds ?? []).slice(0, 100);
    let contains: { id: string; title: string }[] = [];
    if (nativeIds.length) { const kids = await itemsByIds(nativeIds, staff); contains = nativeIds.map((id) => kids.get(id)).filter((k): k is ItemRow => !!k).map((k) => ({ id: k.id, title: k.title })); }
    else if (postIds.length) { const kids = await postsBySourceId(postIds, staff); contains = postIds.map((id) => kids.get(id)).filter((k): k is NonNullable<typeof k> => !!k).map((k) => ({ id: k.id, title: k.title })); }
    const text = r.bodyText ?? "";
    const offset = Math.min(a.offset ?? 0, text.length), size = a.max_chars ?? 20_000;
    const part = text.slice(offset, offset + size);
    const files = [
      ...r.attachmentsFull.map((f) => ({ name: f.name, kind: f.type, link: `${base()}/api/files/${f.id}` })),
      ...((r.nativeAttachments ?? []) as { driveId: string; name: string; mime: string | null; kind: string }[]).map((f) => ({ name: f.name, kind: f.kind, link: isGoogleAppsMime(f.mime) ? googleUrl(googleKindOfMime(f.mime), f.driveId) : `${base()}/api/files/native/${f.driveId}` })),
    ];
    // Reading through Claude counts as use, the same as opening the page does, so ranking keeps learning.
    if (offset === 0) await recordSignal(user.id, r.id, "click", { via: "connector" }).catch((e: Error) => logger.warn({ err: e.message }, "connector click signal failed"));
    const s = toSummary(r as ItemRow);
    return { detail: { id: r.id }, data: {
      ...brief(s), author: r.authorName, published: r.publishedAt ? new Date(r.publishedAt).toISOString().slice(0, 10) : null, original: r.url,
      ...(a.format === "html" && r.bodyHtml ? { body_html: (await readerHtml(r.bodyHtml, r.authorName, staff)).slice(0, 400_000) } : {}),
      text: part, text_from: offset, text_total_chars: text.length, ...(offset + part.length < text.length ? { next_offset: offset + part.length } : {}),
      files, linked_documents: r.linkedDocs.map((d) => ({ url: d.url, kind: d.kind, readable: d.status === "ok" })), ...(contains.length ? { contains } : {}),
      on_the_map: pl, helpful_votes: { yes: votes?.yes ?? 0, no: votes?.no ?? 0 },
      // Where the resource is edited. There is exactly one such place for each, which is the point of the distinction.
      ...(r.sourceKind === "native" && r.nativeKind !== "series" ? { kept: r.nativeKind === "google" ? { as: "linked", edit: "In Google. Wisdom re-reads the file when it changes.", google_file: r.url } : { as: "held", edit: r.nativeKind === "text" ? "In Wisdom, on the resource's edit page." : "By replacing the file on the resource's edit page.", edit_page: `${base()}/admin/resources/${r.id}` } } : {}),
      ...(staff ? { staff: { hidden: r.hidden, review_status: r.reviewStatus, staff_note: r.staffNote, stages: r.stages ?? [], pinned_stage: r.pinnedStage, title_override: r.displayTitle, description_override: r.displayDescription } } : {}),
    } };
  }));

  server.registerTool("browse_map", {
    title: "Browse by job",
    description: "The library organized by the job in front of a teacher leader. With no arguments, returns every job and its sub-jobs with how many resources each holds. With subjob_key, returns the resources placed in that sub-job, best first.",
    inputSchema: { subjob_key: z.string().max(120).optional().describe("A sub-job key from the map, such as board.meetings.") },
    annotations: READ,
  }, run("browse_map", async (a) => {
    const db = getDb();
    if (a.subjob_key) {
      const [row] = await db.select({ sub: subjobs, job: jobs }).from(subjobs).innerJoin(jobs, eq(jobs.id, subjobs.jobId)).where(eq(subjobs.key, a.subjob_key));
      // A staff-only or hidden job is not on a teacher leader's map, so its sub-jobs are not reachable by key either.
      if (!row || (!staff && (row.job.hidden || row.job.staffOnly))) throw new ToolError("There is no sub-job with that key. Call browse_map with no arguments to see the keys.");
      const list = await itemsForSubjob(row.sub.id, staff, reader);
      return { detail: { subjob: a.subjob_key }, data: { job: { key: row.job.key, name: row.job.name }, subjob: { key: row.sub.key, name: row.sub.name, description: row.sub.description, stages: row.sub.stages }, resources: list.map(brief) } };
    }
    const [js, ss, counts, me] = await Promise.all([db.select().from(jobs).orderBy(jobs.sort), db.select().from(subjobs).orderBy(subjobs.sort), subjobItemCounts(staff, reader), db.select({ stage: users.stage }).from(users).where(eq(users.id, user.id))]);
    return { data: {
      stages: STAGES, my_stage: isStage(me[0]?.stage) ? me[0]!.stage : null,
      jobs: js.filter((j) => staff || (!j.hidden && !j.staffOnly)).map((j) => ({ key: j.key, name: j.name, description: j.description, ...(j.staffOnly ? { staff_only: true } : {}), ...(j.hidden ? { hidden: true } : {}),
        subjobs: ss.filter((s) => s.jobId === j.id).map((s) => ({ key: s.key, name: s.name, description: s.description, stages: s.stages, resources: counts.get(s.id) ?? 0 })) })),
    } };
  }));

  server.registerTool("whats_new", {
    title: "What is new and where to start",
    description: "Recently added or updated resources, the resources staff suggest starting with for a stage of the School Startup Journey, and what the network is using most.",
    inputSchema: {
      stage: z.enum(["discovery", "visioning", "planning", "startup", "open", "all"]).optional().describe("Stage to tailor to. Defaults to the stage this person has set, if any. Pass all to ignore their stage."),
      days: z.number().int().min(1).max(365).optional().describe("How far back 'recent' reaches. Default 45."),
    },
    annotations: READ,
  }, run("whats_new", async (a) => {
    const db = getDb();
    const [me] = await db.select({ stage: users.stage }).from(users).where(eq(users.id, user.id));
    const stage: StageKey | null = a.stage === "all" ? null : a.stage ?? (isStage(me?.stage) ? me!.stage as StageKey : null);
    const s = await getSettings();
    const since = new Date(Date.now() - (a.days ?? 45) * 86400_000);
    // Same shape as "most used": a resource counts once, under its primary placement, and staff-only jobs stay out.
    const changed = sql`coalesce(${items.sourceUpdatedAt}, ${items.publishedAt})`;
    const recent = await db.select({ ...itemSelect }).from(items).leftJoin(itemMeta, eq(itemMeta.itemId, items.id)).innerJoin(placements, and(eq(placements.itemId, items.id), eq(placements.isPrimary, true))).innerJoin(subjobs, eq(subjobs.id, placements.subjobId)).innerJoin(jobs, eq(jobs.id, subjobs.jobId))
      .where(and(visibleWhere(staff), eq(jobs.staffOnly, false), eq(jobs.hidden, false), sql`${itemMeta.datedLabel} is null`, sql`${changed} > ${since}`, stage ? sql`${stage} = any(${subjobs.stages})` : undefined, filterWhere(reader))).orderBy(desc(changed)).limit(10);
    const [start, used] = await Promise.all([stage ? startHere(stage, staff, s.startHereCap, reader) : Promise.resolve([]), mostUsed(staff, 8, reader)]);
    return { detail: { stage }, data: { stage, recently_updated: recent.map((r) => brief(toSummary(r as ItemRow))), start_here: start.map(brief), most_used: used.map(brief), ...(stage || a.stage === "all" ? {} : { note: "This person has not set a stage. Ask where they are in the journey and call set_my_stage to tailor this." }) } };
  }));

  // ---- the person's own settings

  server.registerTool("my_profile", {
    title: "Who is connected",
    description: "The connected person's name, role, stage of the School Startup Journey, and their language and region filters, which every search and list here already applies.",
    inputSchema: {}, annotations: READ,
  }, run("my_profile", async () => {
    const [me] = await getDb().select({ stage: users.stage }).from(users).where(eq(users.id, user.id));
    return { data: { name: user.name, role: staff ? "staff" : "teacher_leader", stage: isStage(me?.stage) ? me!.stage : null, stages: STAGES, language_filter: user.resourceLanguage, region_filter: user.resourceRegions } };
  }));

  server.registerTool("set_my_stage", {
    title: "Set my stage",
    description: "Record which stage of the School Startup Journey this person is in, so suggestions fit. Only call this when they have told you their stage.",
    inputSchema: { stage: z.enum(["discovery", "visioning", "planning", "startup", "open"]).nullable().describe("The stage, or null to clear it.") },
    annotations: { ...WRITE, idempotentHint: true },
  }, run("set_my_stage", async (a) => {
    await getDb().update(users).set({ stage: a.stage }).where(eq(users.id, user.id));
    return { data: { stage: a.stage }, detail: { stage: a.stage } };
  }));

  // ---- getting a draft reviewed

  server.registerTool("list_review_types", {
    title: "Kinds of document Wisdom can review",
    description: "The kinds of document Wildflower has written review guidance for, such as a family handbook or a tuition policy. Use this to find the type that fits a draft before calling get_review_guide.",
    inputSchema: {}, annotations: READ,
  }, run("list_review_types", async () => {
    const ts = await getDb().select({ key: materialTypes.key, name: materialTypes.name, description: materialTypes.shortDescription, job: materialTypes.jobKey }).from(materialTypes).where(eq(materialTypes.active, true)).orderBy(asc(materialTypes.sort));
    return { data: { types: ts } };
  }));

  server.registerTool("get_review_guide", {
    title: "Guidance for reviewing a draft",
    description: "Everything needed to review a draft of one kind of document the way Wildflower would: the reviewer's brief, what good looks like for this type, the objectives to score it against, and the resources to recommend. The draft itself is never sent here; review it in the conversation.",
    inputSchema: { type_key: z.string().max(80).describe("A key from list_review_types.") },
    annotations: READ,
  }, run("get_review_guide", async (a) => {
    const db = getDb();
    const [t] = await db.select().from(materialTypes).where(eq(materialTypes.key, a.type_key));
    if (!t || (!t.active && !staff)) throw new ToolError("There is no review guidance for that type. Call list_review_types to see the keys.");
    const [basePrompt, res, school] = await Promise.all([
      currentBasePrompt(),
      db.select({ ...itemSelect, sort: typeResources.sort }).from(typeResources).innerJoin(items, eq(items.id, typeResources.itemId)).leftJoin(itemMeta, eq(itemMeta.itemId, items.id)).where(and(eq(typeResources.typeId, t.id), visibleWhere(staff))).orderBy(asc(typeResources.sort)),
      schoolContext(user.id).catch(() => ({ count: 0, titles: [] as string[], text: "" })),
    ]);
    return { detail: { type: t.key, version: t.version }, data: {
      type: { key: t.key, name: t.name, description: t.shortDescription, version: t.version },
      reviewer_brief: basePrompt.text, what_good_looks_like: t.guideMd,
      objectives: t.rubric.map((c) => ({ objective: c.criterion, description: c.description })), notes_for_the_reviewer: t.reviewerNotes,
      resources_you_may_recommend: res.map((r) => brief(toSummary(r as ItemRow))),
      about_their_school: school.count ? { documents: school.titles, text: school.text } : null,
      how_to_report: "Give a verdict (Ready to use, Nearly ready, or Needs significant work), the one thing to fix first, a score from 1 to 5 against each objective with a short note, what is strong, the priority changes with why and how, and anything a person such as a lawyer, licensor or their Operations Guide must confirm. Recommend only the resources listed here or ones found with search_wisdom. Where the brief describes a JSON reply, treat it as the list of parts to cover, and write the review as prose.",
    } };
  }));

  // ---- telling Wisdom what happened

  server.registerTool("log_question", {
    title: "Record a question and its outcome",
    description: "Record a question the person asked and how it turned out: whether the library answered it and which resources were cited. Call once per question, after answering. Set send_to_staff when the person wants Foundation staff to look at it, which puts it in the staff queue. Do not include drafts or personal details that were not part of the question.",
    inputSchema: {
      question: z.string().trim().min(2).max(1500).describe("The question in the person's own words."),
      answered: z.boolean().describe("True when the library's content answered it. False when it did not cover it."),
      cited_resource_ids: z.array(z.string().uuid()).max(12).optional().describe("Ids of the resources the answer relied on."),
      answer_summary: z.string().trim().max(4000).optional().describe("A short summary of the answer given, so staff can see what the person was told."),
      send_to_staff: z.boolean().optional().describe("True only when the person asked for a human to look at this."),
      note_for_staff: z.string().trim().max(2000).optional().describe("What the person wants staff to know, in their words."),
    },
    annotations: WRITE,
  }, run("log_question", async (a) => {
    const db = getDb();
    const cited = a.cited_resource_ids?.length ? await itemsByIds(a.cited_resource_ids, staff) : new Map<string, ItemRow>();
    const citations = [...cited.values()].map((c) => ({ itemId: c.id, title: c.title, url: link(c.id) }));
    const [turn] = await db.insert(chatTurns).values({ userId: user.id, conversationId: randomUUID(), question: a.question, answer: a.answer_summary ?? null, citations, covered: a.answered, model: "claude-connector", source: "connector", staffReviewRequested: a.send_to_staff ?? false }).returning({ id: chatTurns.id });
    if (turn && a.note_for_staff) await db.insert(chatTurnNotes).values({ turnId: turn.id, authorUserId: user.id, authorName: `${user.name} (asker)`, body: a.note_for_staff });
    return { detail: { answered: a.answered, cited: citations.length, to_staff: a.send_to_staff ?? false }, data: { recorded: true, sent_to_staff: a.send_to_staff ?? false, ...(a.send_to_staff ? { what_happens_next: "Foundation staff see this in their questions queue. There is no automatic reply, so suggest the person also reach their Operations Guide if it is urgent." } : {}) } };
  }));

  server.registerTool("rate_resource", {
    title: "Say whether a resource helped",
    description: "Record that a resource was or was not helpful to this person. Only call when they have said so.",
    inputSchema: { id: z.string().uuid(), helpful: z.boolean() },
    annotations: { ...WRITE, idempotentHint: true },
  }, run("rate_resource", async (a) => {
    if (!(await itemsByIds([a.id], staff)).has(a.id)) throw new ToolError("That resource is not in the library.");
    await recordSignal(user.id, a.id, a.helpful ? "helpful_yes" : "helpful_no", { via: "connector" });
    return { data: { recorded: true }, detail: { id: a.id, helpful: a.helpful } };
  }));

  // ---- adding to the library

  const STAGE_KEYS = ["discovery", "visioning", "planning", "startup", "open"] as const;
  const placing = {
    subjob_keys: z.array(z.string().max(120)).max(6).optional().describe("Staff only. Sub-job keys from browse_map to place it under; the first is its main place."),
    stages: z.array(z.enum(STAGE_KEYS)).max(5).optional().describe("Staff only. The stages of the School Startup Journey it is for."),
  };
  /** Checks the keys exist before anything is created, so a typo does not leave a published resource nowhere on the map. */
  const checkSubjobs = async (keys: string[] | undefined) => {
    if (!keys?.length) return;
    const found = new Set((await getDb().select({ key: subjobs.key }).from(subjobs).where(inArray(subjobs.key, keys))).map((r) => r.key));
    const missing = keys.filter((k) => !found.has(k));
    if (missing.length) throw new ToolError(`There is no sub-job with the key ${missing.join(", ")}. Call browse_map to see the keys.`);
  };
  const afterCreate = async (id: string, a: { subjob_keys?: string[]; stages?: string[] }) => {
    if (staff && (a.subjob_keys?.length || a.stages?.length)) await setPlacements(id, a.subjob_keys ?? [], a.stages ?? []);
    const placed = staff && !!a.subjob_keys?.length;
    return { id, status: staff ? "published" : "pending", ...(staff ? { link: link(id), next: placed ? "It is published and on the map." : "It is published but not on the map. Place it with staff_move_resource." } : { next: "Foundation staff will review it before it appears in the library. my_contributions shows where it stands." }) };
  };

  server.registerTool("create_resource", {
    title: "Add a resource written here",
    description: "Add a new resource to the library from text written in this conversation: a guide, template, example, policy or checklist. Send the finished text as Markdown. A teacher leader's goes to Foundation staff for review; a staff member's is published straight away. Show the person the final title and text and get a yes before calling.",
    inputSchema: {
      title: z.string().trim().min(3).max(200),
      body_markdown: z.string().trim().min(50).max(200_000).describe("The whole resource as Markdown: headings, lists, links, tables."),
      description: z.string().trim().max(600).optional().describe("One or two sentences on what it is and when to use it. Shown on the card."),
      note: z.string().trim().max(4000).optional().describe("A note to the staff member who reviews it: where it came from, what it replaces."),
      review_type_key: z.string().max(80).optional().describe("The kind of document, as a key from list_review_types, when one fits."),
      ...placing,
    },
    annotations: WRITE,
  }, run("create_resource", async (a) => {
    if (staff) await checkSubjobs(a.subjob_keys);
    let created: { id: string };
    try { created = await createNativeItem({ kind: "text", title: a.title, description: a.description ?? null, bodyMarkdown: a.body_markdown, materialTypeKey: a.review_type_key ?? null, note: a.note ?? null, status: staff ? "published" : "pending", authorUserId: user.id, by: actor }); }
    catch (e) { throw new ToolError((e as Error).message); }
    return { detail: { id: created.id, chars: a.body_markdown.length }, data: await afterCreate(created.id, a) };
  }));

  server.registerTool("share_resource", {
    title: "Add a Google file",
    description: "Add a Google Doc, Sheet, Slides or Drive file to the library by its link. A teacher leader's goes to Foundation staff for review; a staff member's is published straight away. The file must be shared so that Wisdom can read it. Confirm the title and link with the person first.",
    inputSchema: {
      url: z.string().url().max(2000).describe("The Google Docs, Sheets, Slides or Drive link."),
      title: z.string().trim().max(200).optional().describe("Title to show. Defaults to the file's own name."),
      description: z.string().trim().max(600).optional().describe("One or two sentences on what it is and when it is useful."),
      note: z.string().trim().max(4000).optional().describe("A note to the staff member who reviews it."),
      review_type_key: z.string().max(80).optional().describe("The kind of document, as a key from list_review_types, when one fits."),
      ...placing,
    },
    annotations: { ...WRITE, openWorldHint: true },
  }, run("share_resource", async (a) => {
    if (staff) await checkSubjobs(a.subjob_keys);
    let created: { id: string };
    // createNativeItem explains itself in words meant for the person (a private file, a link that is not Google's).
    try { created = await createNativeItem({ kind: "google", title: a.title, description: a.description ?? null, url: a.url, materialTypeKey: a.review_type_key ?? null, note: a.note ?? null, status: staff ? "published" : "pending", authorUserId: user.id, by: actor }); }
    catch (e) { throw new ToolError((e as Error).message); }
    return { detail: { id: created.id }, data: await afterCreate(created.id, a) };
  }));

  server.registerTool("request_upload_link", {
    title: "Get a link for sending a file",
    description: "For a file on the person's own device, such as a PDF: returns a one-time link they open in their browser to send it. A file cannot be sent through this conversation. Give them the link as it is. It takes one file and lasts 30 minutes. Afterwards, my_contributions shows whether it arrived.",
    inputSchema: {
      title: z.string().trim().max(200).optional().describe("Title to show. Defaults to the file's name."),
      description: z.string().trim().max(600).optional(),
      note: z.string().trim().max(4000).optional().describe("A note to the staff member who reviews it."),
      review_type_key: z.string().max(80).optional(),
    },
    annotations: WRITE,
  }, run("request_upload_link", async (a) => {
    const r = await createUploadLink(user.id, base(), { ...(a.title ? { title: a.title } : {}), ...(a.description ? { description: a.description } : {}), ...(a.note ? { note: a.note } : {}), ...(a.review_type_key ? { materialTypeKey: a.review_type_key } : {}) });
    return { data: { upload_link: r.link, good_for_minutes: r.minutes, files: "One file, up to 25 MB. Word, PowerPoint and Excel files become Google Docs, Slides and Sheets.", after: staff ? "It is published when it arrives. Find it with my_contributions and place it with staff_move_resource." : "It goes to Foundation staff for review when it arrives." } };
  }));

  server.registerTool("my_contributions", {
    title: "What I have contributed",
    description: "The resources this person has added or offered, newest first, with whether each is published, waiting for review or declined, and any note staff left when declining.",
    inputSchema: {}, annotations: READ,
  }, run("my_contributions", async () => {
    const rows = await getDb().select({ id: items.id, title: items.title, status: items.status, kind: items.nativeKind, at: items.publishedAt, declineNote: items.declineNote }).from(items).where(and(eq(items.sourceKind, "native"), eq(items.authorUserId, user.id), sql`${items.removedAt} is null`)).orderBy(desc(items.publishedAt)).limit(50);
    return { data: { contributions: rows.map((r) => ({ id: r.id, title: r.title, status: r.status, kind: r.kind, added: r.at ? r.at.toISOString().slice(0, 10) : null, ...(r.status === "published" ? { link: link(r.id) } : {}), ...(r.declineNote ? { staff_note: r.declineNote } : {}) })) } };
  }));

  if (!staff) return server;

  // ---- staff: the queue and the gaps

  server.registerTool("staff_questions", {
    title: "Staff: questions queue",
    description: "Questions teacher leaders asked for a human to look at, newest first, with what they were told and any staff notes.",
    inputSchema: { show: z.enum(["unreviewed", "reviewed", "all"]).optional().describe("Default unreviewed."), page: z.number().int().min(1).optional() },
    annotations: READ,
  }, run("staff_questions", async (a) => {
    const { questions, total } = await listStaffQuestions({ reviewed: a.show ?? "unreviewed", share: "all", page: a.page ?? 1, limit: 20 });
    return { data: { total, page: a.page ?? 1, questions: questions.map((q) => ({ id: q.id, asked: q.createdAt.slice(0, 10), asker: q.askerName, asker_email: q.askerEmail, question: q.question, told: q.answer, library_answered: q.covered, cited: q.citations.map((c) => ({ title: c.title, link: c.url })), reviewed_by: q.reviewedBy, notes: q.notes.map((n) => ({ by: n.authorName, on: n.createdAt.slice(0, 10), note: n.body })) })) } };
  }));

  server.registerTool("staff_update_question", {
    title: "Staff: note or close a question",
    description: "Add a staff note to a question in the queue, mark it reviewed, or put it back in the queue.",
    inputSchema: { id: z.string().uuid(), note: z.string().trim().min(1).max(10_000).optional(), reviewed: z.boolean().optional() },
    annotations: WRITE,
  }, run("staff_update_question", async (a) => {
    if (a.note === undefined && a.reviewed === undefined) throw new ToolError("Nothing to change: give a note, or say whether it is reviewed.");
    if (a.note && !(await addNote(a.id, { id: user.id, name: user.name }, a.note))) throw new ToolError("There is no question with that id.");
    if (a.reviewed !== undefined && !(await updateQuestion(a.id, actor, { reviewed: a.reviewed }))) throw new ToolError("There is no question with that id.");
    await getDb().insert(auditLog).values({ actor, action: a.note ? "question.note" : "question.review", target: a.id, detail: { via: "connector", reviewed: a.reviewed ?? null, noteChars: a.note?.length ?? 0 } }).catch(() => undefined);
    const q = await getStaffQuestion(a.id);
    return { detail: { id: a.id }, data: { id: a.id, reviewed_by: q?.reviewedBy ?? null, notes: q?.notes.length ?? 0 } };
  }));

  server.registerTool("staff_gap_report", {
    title: "Staff: what people asked and what the library lacked",
    description: "What teacher leaders have been asking through Claude: questions the library did not answer, searches that found nothing, the resources cited most, and how much each tool is used.",
    inputSchema: { days: z.number().int().min(1).max(365).optional().describe("How far back to look. Default 30.") },
    annotations: READ,
  }, run("staff_gap_report", async (a) => {
    const db = getDb(); const days = a.days ?? 30; const since = new Date(Date.now() - days * 86400_000);
    const [unanswered, empty, totals, tools, cited, connected] = await Promise.all([
      db.select({ id: chatTurns.id, question: chatTurns.question, at: chatTurns.createdAt, asker: users.name, toStaff: chatTurns.staffReviewRequested }).from(chatTurns).innerJoin(users, eq(users.id, chatTurns.userId)).where(and(eq(chatTurns.covered, false), gt(chatTurns.createdAt, since))).orderBy(desc(chatTurns.createdAt)).limit(60),
      db.execute(sql`select lower(coalesce(question, query)) as q, count(*)::int as n, max(created_at) as last from search_log where result_count = 0 and created_at > ${since} group by 1 order by n desc, last desc limit 30`),
      db.execute(sql`select count(*)::int as questions, count(*) filter (where covered)::int as answered, count(*) filter (where staff_review_requested)::int as sent_to_staff, count(distinct user_id)::int as askers from chat_turns where created_at > ${since}`),
      db.select({ tool: mcpCalls.tool, calls: sql<number>`count(*)::int`, people: sql<number>`count(distinct ${mcpCalls.userId})::int`, failed: sql<number>`count(*) filter (where not ${mcpCalls.ok})::int` }).from(mcpCalls).where(gt(mcpCalls.createdAt, since)).groupBy(mcpCalls.tool).orderBy(desc(sql`count(*)`)),
      db.execute(sql`select c->>'itemId' as id, max(c->>'title') as title, count(*)::int as n from chat_turns t cross join lateral jsonb_array_elements(t.citations) c where t.created_at > ${since} group by 1 order by n desc limit 15`),
      connectedUserCount(),
    ]);
    const t = (totals.rows[0] ?? {}) as { questions?: number; answered?: number; sent_to_staff?: number; askers?: number };
    return { detail: { days }, data: {
      days, people_connected: connected, questions: t.questions ?? 0, answered_by_library: t.answered ?? 0, sent_to_staff: t.sent_to_staff ?? 0, people_who_asked: t.askers ?? 0,
      not_answered: unanswered.map((u) => ({ id: u.id, on: u.at.toISOString().slice(0, 10), asker: u.asker, question: u.question, sent_to_staff: u.toStaff })),
      searches_with_no_results: (empty.rows as { q: string; n: number }[]).map((r) => ({ asked: r.q, times: r.n })),
      most_cited: (cited.rows as { id: string; title: string; n: number }[]).map((r) => ({ id: r.id, title: r.title, times: r.n })),
      tool_use: tools,
      note: "Questions appear here only when Claude recorded them with log_question, and searches from the web app are included in searches_with_no_results.",
    } };
  }));

  // ---- staff: curation

  server.registerTool("staff_update_resource", {
    title: "Staff: curate a resource",
    description: "Change how a resource is presented or whether teacher leaders see it: mark it essential or recommended, hide or unhide it, override its title, author or description, label it as dated, or leave a staff note. Only the fields given are changed. Confirm the change with the staff member first.",
    inputSchema: {
      id: z.string().uuid(),
      curation: z.enum(["essential", "recommended"]).nullable().optional().describe("null clears it."),
      hidden: z.boolean().optional().describe("True takes it out of teacher leaders' view everywhere."),
      title: z.string().trim().max(300).nullable().optional().describe("Title to show instead of the source's. null or empty goes back to the source title."),
      author: z.string().trim().max(200).nullable().optional(),
      description: z.string().trim().max(2000).nullable().optional().describe("null goes back to the source description. An empty string shows no description at all."),
      dated_label: z.string().max(40).nullable().optional().describe("A short label such as 'From 2021' that marks it as dated. null clears it."),
      staff_note: z.string().max(500).nullable().optional(),
      review_status: z.enum(["none", "pending", "keep", "dated", "hidden"]).optional().describe("The retirement review decision."),
    },
    annotations: { ...WRITE, idempotentHint: true },
  }, run("staff_update_resource", async (a) => {
    const [exists] = await getDb().select({ id: items.id }).from(items).where(eq(items.id, a.id));
    if (!exists) throw new ToolError("There is no resource with that id.");
    const patch = { ...(a.curation !== undefined ? { curation: a.curation } : {}), ...(a.hidden !== undefined ? { hidden: a.hidden } : {}), ...(a.title !== undefined ? { displayTitle: a.title } : {}), ...(a.author !== undefined ? { displayAuthor: a.author } : {}), ...(a.description !== undefined ? { displayDescription: a.description } : {}), ...(a.dated_label !== undefined ? { datedLabel: a.dated_label } : {}), ...(a.staff_note !== undefined ? { staffNote: a.staff_note } : {}), ...(a.review_status !== undefined ? { reviewStatus: a.review_status } : {}) };
    if (!Object.keys(patch).length) throw new ToolError("Nothing to change.");
    await applyMetaPatch(a.id, patch, actor);
    return { detail: { id: a.id, fields: Object.keys(patch) }, data: { id: a.id, changed: Object.keys(patch), link: link(a.id) } };
  }));

  server.registerTool("staff_move_resource", {
    title: "Staff: place a resource on the map",
    description: "Put a resource into a sub-job. With from_subjob_key it moves from there; without, it is added. Set copy to keep it in both. Its other placements are left alone. Confirm with the staff member first.",
    inputSchema: { id: z.string().uuid(), to_subjob_key: z.string().max(120), from_subjob_key: z.string().max(120).optional(), copy: z.boolean().optional() },
    annotations: WRITE,
  }, run("staff_move_resource", async (a) => {
    const r = await moveItem(a.id, { to: a.to_subjob_key, from: a.from_subjob_key ?? null, copy: a.copy ?? false }, actor);
    const pl = await getDb().select({ subjob_key: subjobs.key, subjob: subjobs.name, primary: placements.isPrimary }).from(placements).innerJoin(subjobs, eq(subjobs.id, placements.subjobId)).where(eq(placements.itemId, a.id)).orderBy(desc(placements.isPrimary));
    return { detail: { id: a.id, to: a.to_subjob_key }, data: { id: a.id, moved: r.moved, on_the_map: pl } };
  }));

  // ---- staff: contributions

  server.registerTool("staff_pending_contributions", {
    title: "Staff: contributions waiting for review",
    description: "Resources teacher leaders have offered that are waiting for a staff decision. With no arguments, lists them with the start of each. With id, returns one in full so it can be read before deciding.",
    inputSchema: { id: z.string().uuid().optional().describe("A contribution to read in full.") },
    annotations: READ,
  }, run("staff_pending_contributions", async (a) => {
    const db = getDb();
    const waiting = and(eq(items.sourceKind, "native"), eq(items.status, "pending"), sql`${items.removedAt} is null`);
    if (a.id) {
      const [r] = await db.select({ id: items.id, title: items.title, description: items.description, url: items.url, note: items.contributionNote, type: items.materialTypeKey, kind: items.nativeKind, at: items.publishedAt, by: users.name, byEmail: users.email, text: items.bodyText, markdown: items.bodyMarkdown }).from(items).leftJoin(users, eq(users.id, items.authorUserId)).where(and(waiting, eq(items.id, a.id)));
      if (!r) throw new ToolError("There is no contribution waiting with that id.");
      const text = r.markdown ?? r.text ?? "";
      return { detail: { id: r.id }, data: { id: r.id, title: r.title, description: r.description, kind: r.kind, link: r.url.startsWith("/") ? null : r.url, shared_by: r.by, email: r.byEmail, on: r.at ? r.at.toISOString().slice(0, 10) : null, note_from_contributor: r.note, review_type: r.type, text: text.slice(0, 40_000), text_total_chars: text.length, ...(text ? {} : { reading: "Wisdom could not read any text from this file. Open the link to look at it." }) } };
    }
    const rows = await db.select({ id: items.id, title: items.title, description: items.description, url: items.url, note: items.contributionNote, type: items.materialTypeKey, kind: items.nativeKind, at: items.publishedAt, by: users.name, start: sql<string>`left(coalesce(${items.bodyMarkdown}, ${items.bodyText}, ''), 400)` }).from(items).leftJoin(users, eq(users.id, items.authorUserId)).where(waiting).orderBy(desc(items.publishedAt)).limit(50);
    return { data: { review_page: `${base()}/admin/queues/contributions`, waiting: rows.map((r) => ({ id: r.id, title: r.title, description: r.description, kind: r.kind, link: r.url.startsWith("/") ? null : r.url, shared_by: r.by, on: r.at ? r.at.toISOString().slice(0, 10) : null, note_from_contributor: r.note, review_type: r.type, starts: r.start })) } };
  }));

  server.registerTool("staff_review_contribution", {
    title: "Staff: approve or decline a contribution",
    description: "Decide a waiting contribution. Approving publishes it to every teacher leader and places it on the map, so it needs at least one sub-job. Declining keeps it out and records a note the contributor can see. Read it first, and confirm the decision, placement and any new title with the staff member before calling.",
    inputSchema: {
      id: z.string().uuid(),
      decision: z.enum(["approve", "decline"]),
      subjob_keys: z.array(z.string().max(120)).max(6).optional().describe("For approve: sub-job keys from browse_map. The first is its main place."),
      stages: z.array(z.enum(STAGE_KEYS)).max(5).optional().describe("For approve: the stages it is for."),
      title: z.string().trim().max(200).optional().describe("For approve: a clearer title, if the contributor's needs one."),
      description: z.string().trim().max(600).optional().describe("For approve: the description to show on the card."),
      note: z.string().trim().max(2000).optional().describe("For decline: why, in words the contributor will read."),
      keep_linked_to_contributors_file: z.boolean().optional().describe("For approve, when the contribution is a Google link. By default Wisdom copies the file into its own Drive and links to the copy, so the contributor's later edits do not publish unreviewed. Set true only when the contributor will keep maintaining the file and the staff member accepts that."),
    },
    annotations: WRITE,
  }, run("staff_review_contribution", async (a) => {
    const [it] = await getDb().select({ status: items.status }).from(items).where(and(eq(items.id, a.id), eq(items.sourceKind, "native")));
    if (!it) throw new ToolError("There is no contribution with that id.");
    if (it.status !== "pending") throw new ToolError(`That contribution is already ${it.status}.`);
    if (a.decision === "decline") {
      await declineContribution(a.id, a.note ?? null, actor);
      return { detail: { id: a.id, decision: "decline" }, data: { id: a.id, status: "declined", note_recorded: !!a.note, next: "The contributor sees this under their contributions. Nothing is sent to them, so tell them yourself if they should know." } };
    }
    // The admin page lets a contribution be approved onto no sub-job at all; from here that would publish
    // something nobody can browse to, with no screen in front of the staff member to show it happened.
    if (!a.subjob_keys?.length) throw new ToolError("Approving needs at least one sub-job to place it under. Call browse_map to choose.");
    await checkSubjobs(a.subjob_keys);
    // Google refusing the copy is the one failure here with something to do about it, so it is said in full.
    try { await approveContribution(a.id, { subjobKeys: a.subjob_keys, stages: a.stages ?? [], copyToWisdom: !a.keep_linked_to_contributors_file, ...(a.title ? { title: a.title } : {}), ...(a.description !== undefined ? { description: a.description } : {}) }, actor); }
    catch (e) { throw new ToolError(`${(e as Error).message} It is still waiting. To publish it linked to the contributor's own file, approve again with keep_linked_to_contributors_file.`); }
    const [after] = await getDb().select({ nativeKind: items.nativeKind, url: items.url }).from(items).where(eq(items.id, a.id));
    return { detail: { id: a.id, decision: "approve", subjobs: a.subjob_keys }, data: { id: a.id, status: "published", link: link(a.id), placed_under: a.subjob_keys, stages: a.stages ?? [], ...(after?.nativeKind === "google" ? { kept: "linked", google_file: after.url, note: a.keep_linked_to_contributors_file ? "Linked to the contributor's own file: what they change there appears here." : "Linked to a copy in the Wisdom Drive. Edit that copy, not the contributor's original." } : { kept: "held" }) } };
  }));

  server.registerTool("staff_convert_to_google_doc", {
    title: "Staff: turn a written resource into a Google Doc",
    description: "Turn a resource held in Wisdom as a page into a Google Doc in the Wisdom Drive and link to it. From then on it is edited in Google and Wisdom re-reads it when it changes. staff_hold_in_wisdom does the reverse.",
    inputSchema: { id: z.string().uuid() },
    annotations: { ...WRITE, openWorldHint: true },
  }, run("staff_convert_to_google_doc", async (a) => {
    let r: { url: string | null };
    try { r = await toGoogleDoc(a.id, actor); } catch (e) { throw new ToolError((e as Error).message); }
    return { detail: { id: a.id }, data: { id: a.id, google_doc: r.url, link: link(a.id) } };
  }));

  server.registerTool("staff_hold_in_wisdom", {
    title: "Staff: hold a linked Google Doc in Wisdom",
    description: "Stop reading a resource from its Google Doc and hold it in Wisdom instead. The document's current content comes in as a page, with its headings, lists, links, tables and pictures; fonts, colors and page layout do not. From then on it is edited in Wisdom and changes to the Google file no longer appear. The Google file is left as it is. Only for Google Docs: a Sheet or Slides stays linked. Confirm with the staff member first.",
    inputSchema: { id: z.string().uuid() },
    annotations: WRITE,
  }, run("staff_hold_in_wisdom", async (a) => {
    let r: Awaited<ReturnType<typeof detachToHeld>>;
    try { r = await detachToHeld(a.id, actor); } catch (e) { throw new ToolError((e as Error).message); }
    return { detail: { id: a.id }, data: { id: a.id, kept: "held", link: link(a.id), edit_page: `${base()}/admin/resources/${a.id}`, brought_in: { characters: r.chars, pictures: r.pictures, tables: r.tables }, former_google_file: r.formerGoogleUrl, next: "The Google file still exists and is no longer connected. Tell the staff member to delete or archive it so there are not two copies to keep up." } };
  }));

  return server;
}
