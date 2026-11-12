// Types shared by the API and the web app. Keep this file dependency-free.
export * from "./language.js";
export * from "./linkify.js";
export * from "./region.js";
import type { ItemLanguage, ResourceLanguage } from "./language.js";

export type Role = "teacher_leader" | "staff";
export interface SessionUser { id: string; email: string; name: string; role: Role; resourceLanguage: ResourceLanguage; resourceRegions: string[]; }
export type StageKey = "discovery" | "visioning" | "planning" | "startup" | "open";
export const STAGES: { key: StageKey; name: string; description: string }[] = [
  { key: "discovery", name: "Discovery", description: "Exploring whether to open a Wildflower school" },
  { key: "visioning", name: "Visioning", description: "Committed; shaping vision, name, partners, and region" },
  { key: "planning", name: "Planning", description: "Forming the nonprofit and board, budgeting, space search, licensing, marketing launch" },
  { key: "startup", name: "Startup", description: "The months before opening: enrolling, hiring, fit-out, systems" },
  { key: "open", name: "Open", description: "Running the school, year 1 and beyond" },
];
export type Curation = "essential" | "recommended" | null;
export interface ItemSummary {
  id: string; title: string; url: string; kind: "post" | "series" | "question";
  /** Who wrote it, with staff's correction applied. Absent where a list has no use for it. */
  author?: string | null;
  /** Who looks after it now, when that is someone other than the author. */
  steward?: string | null;
  description: string | null; summary: string | null; contentType: string | null;
  updatedAt: string | null; views: number; score: number; curation: Curation; dated: string | null;
  linkOnly: boolean; attachmentCount: number; seriesTitles: string[]; language: ItemLanguage; why?: string | null;
  /** The regions this is written for (keys from REGIONS). Empty means it applies wherever you are. */
  regions: string[];
  /** For a series card on the map: the items inside it, in order. */
  children?: { id: string; title: string }[];
  isSeries?: boolean;
}
export interface SubjobSummary { id: string; key: string; name: string; description: string | null; stages: StageKey[]; itemCount: number; }
export interface JobSummary { id: string; key: string; name: string; description: string | null; staffOnly: boolean; hidden: boolean; subjobs: SubjobSummary[]; }
export interface Verdict { verdict: "Ready to use" | "Nearly ready" | "Needs significant work"; }
export interface ReviewResult {
  verdict: Verdict["verdict"]; one_thing: string; summary: string;
  rubric: { criterion: string; score: number; note: string }[];
  strengths: string[];
  priority_changes: { what: string; why: string; how: string }[];
  line_notes: { quote: string; note: string }[];
  example_rewrites: { original: string; rewrite: string; why: string }[];
  questions_for_writer: string[];
  verify_with_humans: string[];
  recommended_resources: { title: string; url: string; why: string }[];
  nits: string[];
}
export interface Settings {
  killSwitch: boolean; reviewModel: string; reviewEffort: string; assistModel: string; chatModel: string; embeddingModel: string;
  reviewsPerAccountPerDay: number; reviewsPerDayGlobal: number; chatTurnsPerAccountPerDay: number; chatTurnsPerDayGlobal: number;
  draftsPerAccountPerDay: number; draftsPerDayGlobal: number;
  maxUploadBytes: number; maxDraftChars: number; maxReviewOutputTokens: number;
  scoreWeights: { curation: number; usage: number; freshness: number }; freshnessLadder: number[]; evergreenContentTypes: string[];
  startHereCap: number; signalBlendCeiling: number; signalHalfLifeDays: number; staffDomain: string;
  /** Off once everything has been imported from Connected: the nightly index then no longer talks to Connected. */
  connectedSyncEnabled: boolean;
}
export const SETTING_DEFAULTS: Settings = {
  killSwitch: false, reviewModel: "gpt-5.6-sol", reviewEffort: "medium", assistModel: "gpt-5.6-luna", chatModel: "gpt-5.6-luna", embeddingModel: "text-embedding-3-small",
  reviewsPerAccountPerDay: 8, reviewsPerDayGlobal: 120, chatTurnsPerAccountPerDay: 300, chatTurnsPerDayGlobal: 3000,
  draftsPerAccountPerDay: 10, draftsPerDayGlobal: 150,
  maxUploadBytes: 5 * 1024 * 1024, maxDraftChars: 30000, maxReviewOutputTokens: 4000,
  scoreWeights: { curation: 0.4, usage: 0.35, freshness: 0.25 }, freshnessLadder: [1, 0.8, 0.6, 0.4, 0.25], evergreenContentTypes: ["template", "policy", "definition"],
  startHereCap: 7, signalBlendCeiling: 0.6, signalHalfLifeDays: 90, staffDomain: "wildflowerschools.org",
  connectedSyncEnabled: true,
};

export type FeedbackCategory = "bug" | "question" | "suggestion" | "other";
export type FeedbackStatus = "open" | "in_progress" | "resolved" | "dismissed";
export interface FeedbackResult {
  id: string; category: FeedbackCategory; status: FeedbackStatus; message: string;
  pageUrl: string | null; pagePath: string | null; pageTitle: string | null; screenshotDataUrl: string | null;
  context: Record<string, unknown>; adminNotes: string | null; createdByUserId: string; resolvedByUserId: string | null;
  resolvedAt: string | null; createdAt: string; updatedAt: string; reporterName: string; reporterEmail: string;
}
/**
 * What a search looked like when someone sent feedback on its results, stored under context.search.
 *
 * Kept small on purpose: app_feedback.context is capped at 20 KB, so the results are trimmed to the
 * first page a reader actually saw and each title is truncated.
 */
export interface SearchFeedbackContext {
  query: string;
  rewritten: string | null;
  mode: string;
  filters: { language: string; regions: string[]; types: string[] };
  resultCount: number;
  results: { position: number; id: string; title: string }[];
}
export const SEARCH_FEEDBACK_RESULTS = 25;
export const SEARCH_FEEDBACK_TITLE = 140;

export interface FeedbackListResult { feedback: FeedbackResult[]; pagination: { page: number; limit: number; total: number; pageCount: number } }

export interface SchoolMaterial { id: string; kind: "file" | "link"; title: string; filename: string | null; url: string | null; charCount: number; status: string; createdAt: string }

export type ShareAttribution = "anonymous" | "name";
export type ShareStatus = "none" | "pending" | "approved" | "rejected";
/** What the asker chose when they sent the question, stored on the chat turn. */
export interface AskOptions { staffReview: boolean; share: boolean; shareAttribution: ShareAttribution }
export interface Citation { itemId: string; title: string; url: string }
/** One of the signed-in user's own earlier questions, shown at the bottom of Ask. */
export interface MyQuestion { id: string; question: string; answer: string | null; citations: Citation[]; covered: boolean | null; createdAt: string; staffReviewRequested: boolean; share: { requested: boolean; attribution: ShareAttribution; status: ShareStatus } }
/** An approved shared question, shown publicly on Ask. Only carries a name when the asker chose to. */
export interface SharedExample { id: string; question: string; answer: string | null; citations: Citation[]; askerName: string | null; createdAt: string }
export interface QuestionNote { id: string; body: string; authorName: string; createdAt: string }
/** A question in the staff Questions queue. */
export interface StaffQuestion extends MyQuestion { askerName: string; askerEmail: string; reviewedBy: string | null; reviewedAt: string | null; shareDecidedBy: string | null; shareDecidedAt: string | null; notes: QuestionNote[] }
export interface StaffQuestionListResult { questions: StaffQuestion[]; pagination: { page: number; limit: number; total: number; pageCount: number } }

/**
 * Document types readers can filter by. "series" and "question" are kinds; the rest are content types.
 * "resource_list" is a content type that outranks the kind: a roster of people or programs is built as
 * a series so its entries nest, but it reads as a list, so it is labelled and filtered as one.
 */
export const DOC_TYPES: { key: string; label: string }[] = [
  { key: "series", label: "Series" }, { key: "resource_list", label: "Resource lists" }, { key: "guide", label: "Guides" }, { key: "template", label: "Templates" }, { key: "example", label: "Examples" }, { key: "data", label: "Data" },
  { key: "training", label: "Training" }, { key: "directory", label: "Directories" }, { key: "policy", label: "Policies" }, { key: "news", label: "News" }, { key: "question", label: "Q&A" }, { key: "link", label: "Links" }, { key: "other", label: "Other" },
];

/**
 * The credit line for a resource. Someone who wrote a resource and has left is still its author; the
 * steward is who to ask about it now. One name is shown plainly, two are told apart.
 */
export function creditLine(author: string | null | undefined, steward: string | null | undefined): string | null {
  const a = author?.trim() || null, s = steward?.trim() || null;
  if (!s || (a && a.toLowerCase() === s.toLowerCase())) return a;
  return a ? `Originally created by ${a}; stewarded by ${s}` : `Stewarded by ${s}`;
}
/**
 * Whether an author credit names this person. Credits are free text ("Sep Kamvar and Matt Kramer") and a
 * sign-in name is whatever Google holds ("Matthew Kramer"), so equality misses real matches: the family
 * name has to agree and one given name has to begin the other.
 */
export function creditNames(author: string | null | undefined, person: string): boolean {
  const split = (n: string) => n.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const p = split(person); if (p.length < 2 || !author) return false;
  return author.split(/,|&|\band\b/i).some((part) => {
    const a = split(part); if (a.length < 2) return false;
    const g1 = a[0]!, g2 = p[0]!;
    return a[a.length - 1] === p[p.length - 1] && (g1.startsWith(g2.slice(0, 3)) || g2.startsWith(g1.slice(0, 3))) && Math.min(g1.length, g2.length) >= 3;
  });
}
