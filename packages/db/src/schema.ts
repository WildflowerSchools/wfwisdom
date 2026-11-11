import { pgEnum, check, pgTable, text, uuid, timestamp, integer, boolean, jsonb, real, bigint, numeric, serial, uniqueIndex, index, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const now = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  googleSub: text("google_sub").notNull().unique(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: text("role").notNull().default("teacher_leader"),
  hostedDomain: text("hosted_domain"),
  stage: text("stage"),
  /** Which resource language the reader last chose: all | en | es. Follows them across devices. */
  resourceLanguage: text("resource_language").notNull().default("all"),
  /** Which region options the reader last ticked (REGIONS keys plus "general"). Empty means no narrowing. */
  resourceRegions: text("resource_regions").array().notNull().default(sql`'{}'::text[]`),
  createdAt: now(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: now(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("sessions_user_idx").on(t.userId)]);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text("updated_by"),
});

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  sort: integer("sort").notNull().default(0),
  staffOnly: boolean("staff_only").notNull().default(false),
  hidden: boolean("hidden").notNull().default(false),
});

export const subjobs = pgTable("subjobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  sort: integer("sort").notNull().default(0),
  stages: text("stages").array().notNull().default(sql`'{}'::text[]`),
}, (t) => [index("subjobs_job_idx").on(t.jobId)]);

/**
 * Jobs and sub-jobs staff removed, by key.
 *
 * The seed inserts every job and sub-job from seed-taxonomy.json and skips the ones that already exist,
 * which meant a merged or deleted one came back empty on the next deploy: its key no longer existed, so
 * there was nothing for the insert to conflict with. A retirement is the record that its absence is
 * deliberate. Creating a job or sub-job with the same key again clears it.
 */
export const taxonomyRetirements = pgTable("taxonomy_retirements", {
  kind: text("kind").notNull(), // job | subjob
  key: text("key").notNull(),
  retiredAt: timestamp("retired_at", { withTimezone: true }).notNull().defaultNow(),
  retiredBy: text("retired_by"),
  reason: text("reason"),
}, (t) => [primaryKey({ columns: [t.kind, t.key] }), check("taxonomy_retirements_kind", sql`${t.kind} in ('job','subjob')`)]);

export const items = pgTable("items", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceKind: text("source_kind").notNull(), // post | series | question
  sourceId: bigint("source_id", { mode: "number" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  url: text("url").notNull(),
  authorName: text("author_name"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
  views: integer("views").notNull().default(0),
  likes: integer("likes").notNull().default(0),
  comments: integer("comments").notNull().default(0),
  seriesTitles: jsonb("series_titles").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  categories: jsonb("categories").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  audiences: jsonb("audiences").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  contentType: text("content_type"),
  bodyText: text("body_text"),
  /** Sanitized HTML of the post body, text blocks, links and (for questions) answers, ready to render. */
  bodyHtml: text("body_html"),
  /** For series: Connected post ids in order, resolved to items at read time. */
  childPostIds: jsonb("child_post_ids").$type<number[]>().notNull().default(sql`'[]'::jsonb`),
  /** Native items (source_kind = 'native'): content that lives in Google or was written here. */
  nativeKind: text("native_kind"), // google | file | text | series
  googleFileId: text("google_file_id"),
  googleKind: text("google_kind"), // document | spreadsheets | presentation | file
  driveMime: text("drive_mime"),
  /**
   * Pictures inside a Google Doc, copied into the Wisdom Drive. The addresses Google's export gives for a
   * document's images are temporary, so a body that points at them loses its pictures; these are the
   * copies the stored body points at instead. Keyed by a hash of the image so an unchanged picture is
   * not uploaded again on every refresh.
   */
  inlineImages: jsonb("inline_images").$type<{ hash: string; driveId: string; mime: string | null; bytes: number }[]>().notNull().default(sql`'[]'::jsonb`),
  authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
  status: text("status").notNull().default("published"), // published | pending | declined
  contributionNote: text("contribution_note"),
  declineNote: text("decline_note"),
  materialTypeKey: text("material_type_key"),
  childItemIds: jsonb("child_item_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  nativeModifiedAt: timestamp("native_modified_at", { withTimezone: true }),
  bodyMarkdown: text("body_markdown"),
  /** Set when this item was moved here from Connected: where it came from, so old links still resolve. */
  importedFrom: jsonb("imported_from").$type<{ kind: string; sourceId: number; url: string; folderId?: string | null }>(),
  importedAt: timestamp("imported_at", { withTimezone: true }),
  importError: text("import_error"),
  /** Files that live in the Wisdom Drive folder alongside the item (imported attachments). */
  nativeAttachments: jsonb("native_attachments").$type<{ driveId: string; name: string; mime: string | null; bytes: number; kind: string; chars?: number; sourceContentId?: number | null }[]>().notNull().default(sql`'[]'::jsonb`),
  /** Text pulled out of those files and transcripts, merged into body_text so search still finds it. */
  attachmentText: text("attachment_text"),
  /** Short HTML shown above the main content (an imported post's own words when its content is a file). */
  introHtml: text("intro_html"),
  attachments: jsonb("attachments").$type<{ id: number; name: string; type: string; bytes: number; chars: number; mime?: string | null }[]>().notNull().default(sql`'[]'::jsonb`),
  linkedDocs: jsonb("linked_docs").$type<{ url: string; kind: string; status: string; chars: number }[]>().notNull().default(sql`'[]'::jsonb`),
  linkOnly: boolean("link_only").notNull().default(false),
  hasText: boolean("has_text").notNull().default(false),
  summary: text("summary"),
  summaryHash: text("summary_hash"),
  /** Detected from the title, labels and body at index time: en | es | unknown. "unknown" only shows under "All resources". */
  language: text("language").notNull().default("unknown"),
  /** Regions this is written for (keys from REGIONS), read off Connected's audience taxa. Empty means it applies everywhere. */
  regions: text("regions").array().notNull().default(sql`'{}'::text[]`),
  indexedAt: timestamp("indexed_at", { withTimezone: true }).defaultNow().notNull(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  contentHash: text("content_hash"),
}, (t) => [uniqueIndex("items_source_idx").on(t.sourceKind, t.sourceId), index("items_language_idx").on(t.language), index("items_regions_idx").using("gin", t.regions)]);

export const itemChunks = pgTable("item_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  ord: integer("ord").notNull(),
  text: text("text").notNull(),
  textHash: text("text_hash").notNull(),
  embedding: real("embedding").array(),
  model: text("model"),
}, (t) => [index("chunks_item_idx").on(t.itemId)]);

export const placements = pgTable("placements", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  subjobId: uuid("subjob_id").notNull().references(() => subjobs.id, { onDelete: "cascade" }),
  isPrimary: boolean("is_primary").notNull().default(false),
  source: text("source").notNull().default("model"), // model | staff
  why: text("why"),
  position: integer("position"),
}, (t) => [uniqueIndex("placements_item_subjob_idx").on(t.itemId, t.subjobId), index("placements_subjob_idx").on(t.subjobId)]);

export const itemMeta = pgTable("item_meta", {
  itemId: uuid("item_id").primaryKey().references(() => items.id, { onDelete: "cascade" }),
  curation: text("curation"), // essential | recommended | null
  hidden: boolean("hidden").notNull().default(false),
  /** Staff's own title, preferred over the one Connected carries. The indexer never touches it. */
  displayTitle: text("display_title"),
  /** Staff's own author, for material credited to whoever posted it rather than to whoever wrote it. */
  displayAuthor: text("display_author"),
  /** Staff's own description. Null falls back to Connected's; an empty string shows none at all. */
  displayDescription: text("display_description"),
  /** The date the material states about itself, rather than the day it was posted to Connected. */
  displayPublishedAt: timestamp("display_published_at", { withTimezone: true }),
  datedLabel: text("dated_label"),
  pinnedStage: text("pinned_stage"),
  pinnedPosition: integer("pinned_position"),
  staffNote: text("staff_note"),
  stages: text("stages").array().notNull().default(sql`'{}'::text[]`),
  modelOutdated: boolean("model_outdated").notNull().default(false),
  modelOutdatedReason: text("model_outdated_reason"),
  reviewStatus: text("review_status").notNull().default("none"), // none | pending | keep | dated | hidden
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  score: real("score").notNull().default(0),
  scoreComponents: jsonb("score_components").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
  scoreUpdatedAt: timestamp("score_updated_at", { withTimezone: true }),
  wfClicks30d: integer("wf_clicks_30d").notNull().default(0),
  wfHelpfulYes: integer("wf_helpful_yes").notNull().default(0),
  wfHelpfulNo: integer("wf_helpful_no").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const placementSeeds = pgTable("placement_seeds", {
  id: serial("id").primaryKey(),
  sourceKind: text("source_kind").notNull(),
  sourceId: bigint("source_id", { mode: "number" }).notNull(),
  primarySubjob: text("primary_subjob").notNull(),
  secondarySubjobs: text("secondary_subjobs").array().notNull().default(sql`'{}'::text[]`),
  stages: text("stages").array().notNull().default(sql`'{}'::text[]`),
  contentType: text("content_type"),
  outdated: boolean("outdated").notNull().default(false),
  outdatedReason: text("outdated_reason"),
  why: text("why"),
  applied: boolean("applied").notNull().default(false),
}, (t) => [uniqueIndex("placement_seeds_source_idx").on(t.sourceKind, t.sourceId)]);

export const signals = pgTable("signals", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  kind: text("kind").notNull(), // click | search_click | helpful_yes | helpful_no
  context: jsonb("context").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: now(),
}, (t) => [index("signals_item_idx").on(t.itemId), index("signals_created_idx").on(t.createdAt)]);

export const materialTypes = pgTable("material_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  shortDescription: text("short_description"),
  jobKey: text("job_key"),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  guideMd: text("guide_md").notNull(),
  rubric: jsonb("rubric").$type<{ criterion: string; description: string }[]>().notNull().default(sql`'[]'::jsonb`),
  reviewerNotes: text("reviewer_notes").notNull().default(""),
  model: text("model"),
  reasoningEffort: text("reasoning_effort"),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text("updated_by"),
});

export const materialTypeVersions = pgTable("material_type_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  typeId: uuid("type_id").notNull().references(() => materialTypes.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  name: text("name").notNull(),
  shortDescription: text("short_description"),
  guideMd: text("guide_md").notNull(),
  rubric: jsonb("rubric").$type<{ criterion: string; description: string }[]>().notNull(),
  reviewerNotes: text("reviewer_notes").notNull(),
  note: text("note"),
  createdBy: text("created_by"),
  createdAt: now(),
}, (t) => [uniqueIndex("type_versions_idx").on(t.typeId, t.version)]);

export const typeResources = pgTable("type_resources", {
  typeId: uuid("type_id").notNull().references(() => materialTypes.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  sort: integer("sort").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.typeId, t.itemId] })]);

export const typeResourceSeeds = pgTable("type_resource_seeds", {
  id: serial("id").primaryKey(),
  typeKey: text("type_key").notNull(),
  sourceId: bigint("source_id", { mode: "number" }).notNull(),
  sort: integer("sort").notNull().default(0),
}, (t) => [uniqueIndex("type_resource_seeds_idx").on(t.typeKey, t.sourceId)]);

export const basePromptVersions = pgTable("base_prompt_versions", {
  version: serial("version").primaryKey(),
  text: text("text").notNull(),
  note: text("note"),
  createdBy: text("created_by"),
  createdAt: now(),
});

export const submissions = pgTable("submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  typeId: uuid("type_id").notNull().references(() => materialTypes.id),
  typeVersion: integer("type_version").notNull(),
  basePromptVersion: integer("base_prompt_version"),
  parentId: uuid("parent_id"),
  title: text("title"),
  source: text("source").notNull(), // paste | upload | test
  filename: text("filename"),
  draftText: text("draft_text").notNull(),
  charCount: integer("char_count").notNull(),
  status: text("status").notNull().default("queued"), // queued | running | done | failed
  model: text("model"),
  reasoningEffort: text("reasoning_effort"),
  review: jsonb("review"),
  verdict: text("verdict"),
  usage: jsonb("usage").$type<Record<string, number>>(),
  costUsd: numeric("cost_usd", { precision: 10, scale: 5 }),
  error: text("error"),
  createdAt: now(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  emailedAt: timestamp("emailed_at", { withTimezone: true }),
  contributed: boolean("contributed").notNull().default(false),
}, (t) => [index("submissions_user_idx").on(t.userId), index("submissions_created_idx").on(t.createdAt)]);

export const chatTurns = pgTable("chat_turns", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull(),
  question: text("question").notNull(),
  answer: text("answer"),
  citations: jsonb("citations").$type<{ itemId: string; title: string; url: string }[]>().notNull().default(sql`'[]'::jsonb`),
  covered: boolean("covered"),
  model: text("model"),
  usage: jsonb("usage").$type<Record<string, number>>(),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  /** The asker ticked "let staff review this question and answer". Drives the staff Questions queue. */
  staffReviewRequested: boolean("staff_review_requested").notNull().default(false),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  /** The asker ticked "share this question as an example". Nothing is public until staff approve it. */
  shareRequested: boolean("share_requested").notNull().default(false),
  shareAttribution: text("share_attribution").notNull().default("anonymous"), // anonymous | name
  shareStatus: text("share_status").notNull().default("none"), // none | pending | approved | rejected
  shareDecidedBy: text("share_decided_by"),
  shareDecidedAt: timestamp("share_decided_at", { withTimezone: true }),
  /** web: answered by the Ask page. connector: answered by Claude, which reported the outcome here. */
  source: text("source").notNull().default("web"),
  createdAt: now(),
}, (t) => [index("chat_user_idx").on(t.userId), index("chat_created_idx").on(t.createdAt), index("chat_review_idx").on(t.staffReviewRequested, t.createdAt), index("chat_share_idx").on(t.shareStatus, t.createdAt)]);

/** Staff notes on a question and its answer, one row per note so who wrote it and when is kept. */
export const chatTurnNotes = pgTable("chat_turn_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  turnId: uuid("turn_id").notNull().references(() => chatTurns.id, { onDelete: "cascade" }),
  authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
  /** Snapshot of the author's name so the note still reads correctly if the account is removed. */
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  createdAt: now(),
}, (t) => [index("chat_turn_notes_turn_idx").on(t.turnId, t.createdAt), check("chat_turn_notes_body_not_blank", sql`length(trim(${t.body})) > 0`)]);

export const searchLog = pgTable("search_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  query: text("query").notNull(),
  rewritten: text("rewritten"),
  mode: text("mode"),
  resultCount: integer("result_count"),
  /** The asker's question in their own words, when the search came through the Claude connector. */
  question: text("question"),
  /** web | connector | map — which front door the search came through. */
  source: text("source").notNull().default("web"),
  createdAt: now(),
});

export const indexRuns = pgTable("index_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(), // reindex | score | summaries
  status: text("status").notNull().default("running"),
  triggeredBy: text("triggered_by"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  log: text("log").notNull().default(""),
  error: text("error"),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actor: text("actor"),
  action: text("action").notNull(),
  target: text("target"),
  detail: jsonb("detail").$type<Record<string, unknown>>(),
  createdAt: now(),
});

/** App feedback sent from the Feedback button: message, page, and a screenshot as a JPEG data URL (capped at 1 MB). */
export const feedbackCategory = pgEnum("feedback_category", ["bug", "question", "suggestion", "other"]);
export const feedbackStatus = pgEnum("feedback_status", ["open", "in_progress", "resolved", "dismissed"]);
export const appFeedback = pgTable("app_feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  category: feedbackCategory("category").notNull(),
  status: feedbackStatus("status").notNull().default("open"),
  message: text("message").notNull(),
  pageUrl: text("page_url"),
  pagePath: text("page_path"),
  pageTitle: text("page_title"),
  screenshotDataUrl: text("screenshot_data_url"),
  context: jsonb("context").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  adminNotes: text("admin_notes"),
  resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("app_feedback_status_created_idx").on(t.status, t.createdAt),
  index("app_feedback_creator_created_idx").on(t.createdByUserId, t.createdAt),
  check("app_feedback_message_not_blank", sql`length(trim(${t.message})) > 0`),
  check("app_feedback_context_size", sql`pg_column_size(${t.context}) <= 20480`),
  check("app_feedback_screenshot_size", sql`${t.screenshotDataUrl} IS NULL OR octet_length(${t.screenshotDataUrl}) <= 1000000`),
]);

/** Documents and links a teacher leader shares about their school; reviews and drafting use them as context. */
export const userMaterials = pgTable("user_materials", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // file | link
  title: text("title").notNull(),
  filename: text("filename"),
  url: text("url"),
  text: text("text").notNull(),
  charCount: integer("char_count").notNull(),
  status: text("status").notNull().default("ok"), // ok | private | error
  createdAt: now(),
}, (t) => [index("user_materials_user_idx").on(t.userId)]);

/** Each "Draft it for me" call, for limits and cost tracking. */
export const draftGenerations = pgTable("draft_generations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  typeId: uuid("type_id").notNull().references(() => materialTypes.id),
  model: text("model"),
  charCount: integer("char_count").notNull().default(0),
  usage: jsonb("usage").$type<Record<string, number>>(),
  costUsd: numeric("cost_usd", { precision: 10, scale: 5 }),
  error: text("error"),
  createdAt: now(),
}, (t) => [index("draft_generations_user_idx").on(t.userId, t.createdAt)]);

/** Snapshots of a native item's content each time it changes, so an overwritten Google file can be recovered. */
export const itemVersions = pgTable("item_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  bodyText: text("body_text"),
  bodyHtml: text("body_html"),
  bodyMarkdown: text("body_markdown"),
  hash: text("hash"),
  sourceModifiedAt: timestamp("source_modified_at", { withTimezone: true }),
  createdBy: text("created_by"),
  createdAt: now(),
}, (t) => [index("item_versions_item_idx").on(t.itemId, t.version)]);

/**
 * The Claude connector (apps/api/src/mcp). Wisdom is its own OAuth authorization server so a connector
 * signs in with the same Google account as the web app; these three tables are that server's state.
 */
export const mcpClients = pgTable("mcp_clients", {
  clientId: text("client_id").primaryKey(),
  /** The registration as the MCP SDK validated it (RFC 7591), secret included when the client has one. */
  info: jsonb("info").$type<Record<string, unknown>>().notNull(),
  createdAt: now(),
});

/** One sign-in attempt: created when a client asks to authorize, completed when the user approves. */
export const mcpGrants = pgTable("mcp_grants", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().references(() => mcpClients.clientId, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  state: text("state"),
  scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
  resource: text("resource"),
  /** Hashes only: the approve token is shown once on the consent page, the code is sent once to the client. */
  approveHash: text("approve_hash"),
  codeHash: text("code_hash").unique(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: now(),
});

export const mcpTokens = pgTable("mcp_tokens", {
  /** sha256 of the token. The token itself is never stored. */
  hash: text("hash").primaryKey(),
  kind: text("kind").notNull(), // access | refresh
  clientId: text("client_id").notNull().references(() => mcpClients.clientId, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
  resource: text("resource"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: now(),
}, (t) => [index("mcp_tokens_user_idx").on(t.userId), index("mcp_tokens_expires_idx").on(t.expiresAt)]);

/**
 * A one-time link for sending a file from a person's own device. Claude cannot carry a file in a tool
 * call, so it asks for one of these and the person opens it in their browser.
 */
export const mcpUploads = pgTable("mcp_uploads", {
  /** sha256 of the token in the link. */
  hash: text("hash").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** What the person told Claude about the file: title, description, note for staff, material type. */
  meta: jsonb("meta").$type<{ title?: string; description?: string; note?: string; materialTypeKey?: string }>().notNull().default(sql`'{}'::jsonb`),
  itemId: uuid("item_id").references(() => items.id, { onDelete: "set null" }),
  usedAt: timestamp("used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: now(),
});

/** One row per connector tool call: who, which tool, and small keys (an item id, a type key). Never content. */
export const mcpCalls = pgTable("mcp_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  tool: text("tool").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  ok: boolean("ok").notNull().default(true),
  createdAt: now(),
}, (t) => [index("mcp_calls_created_idx").on(t.createdAt), index("mcp_calls_tool_idx").on(t.tool, t.createdAt)]);
