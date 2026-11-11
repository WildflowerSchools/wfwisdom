import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { closeDb, getDb, type Db } from "./index.js";
import { basePromptVersions, jobs, materialTypeVersions, materialTypes, placementSeeds, settings, subjobs, taxonomyRetirements, typeResourceSeeds } from "./schema.js";
import { SETTING_DEFAULTS } from "@wfw/shared";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(resolve(here, "..", f), "utf8");

// Bound statement sizes while avoiding a network round trip for every seed row.
function batches<T>(rows: T[], size = 200): T[][] {
  return Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));
}

/** Idempotent seed: inserts what is missing, never overwrites staff edits. */
export async function seed(db: Db = getDb()): Promise<Record<string, number>> {
  const out: Record<string, number> = {};

  // Settings: insert defaults only where the key does not exist.
  let n = 0;
  for (const rows of batches(Object.entries(SETTING_DEFAULTS).map(([key, value]) => ({ key, value: value as unknown as object })))) {
    const r = await db.insert(settings).values(rows).onConflictDoNothing();
    n += r.rowCount ?? 0;
  }
  out.settings = n;

  // Taxonomy
  const tax = JSON.parse(read("seed-taxonomy.json")) as { jobs: { key: string; name: string; desc?: string; subs: { key: string; name: string }[] }[] };
  const subStages = new Map<string, string[]>();
  const seeds = JSON.parse(read("seed-placements.json")) as { source_kind: string; source_id: number; primary: string; secondary: string[]; stages: string[]; content_type: string; outdated: boolean; outdated_reason: string; why: string }[];
  for (const s of seeds) { const cur = subStages.get(s.primary) ?? []; for (const st of s.stages) if (!cur.includes(st)) cur.push(st); subStages.set(s.primary, cur); }
  const order = ["discovery", "visioning", "planning", "startup", "open"];
  // A job or sub-job staff removed stays removed. Without this the seed recreated it empty on the next
  // deploy, because a deleted key leaves nothing for "insert what is missing" to conflict with.
  const retired = new Set((await db.select({ kind: taxonomyRetirements.kind, key: taxonomyRetirements.key }).from(taxonomyRetirements)).map((r) => `${r.kind}:${r.key}`));
  let nj = 0, ns = 0;
  const activeJobs = tax.jobs.map((j, ji) => ({ ...j, sort: ji * 10 })).filter((j) => !retired.has(`job:${j.key}`));
  for (const rows of batches(activeJobs.map((j) => ({ key: j.key, name: j.name, description: j.desc ?? null, sort: j.sort, staffOnly: j.key === "foundation" })))) {
    const r = await db.insert(jobs).values(rows).onConflictDoNothing();
    nj += r.rowCount ?? 0;
  }
  const jobIds = new Map((await db.select({ id: jobs.id, key: jobs.key }).from(jobs)).map((j) => [j.key, j.id]));
  const subjobRows = activeJobs.flatMap((j) => {
    const jobId = jobIds.get(j.key);
    if (!jobId) return [];
    return j.subs.flatMap((s, si) => retired.has(`subjob:${s.key}`) ? [] : [{
      jobId, key: s.key, name: s.name, sort: si * 10,
      stages: (subStages.get(s.key) ?? []).sort((a, b) => order.indexOf(a) - order.indexOf(b)),
    }]);
  });
  for (const rows of batches(subjobRows)) {
    const r = await db.insert(subjobs).values(rows).onConflictDoNothing();
    ns += r.rowCount ?? 0;
  }
  out.jobs = nj; out.subjobs = ns;

  // Placement seeds (applied by the indexer when items exist)
  let np = 0;
  for (const rows of batches(seeds.map((s) => ({ sourceKind: s.source_kind, sourceId: s.source_id, primarySubjob: s.primary, secondarySubjobs: s.secondary, stages: s.stages, contentType: s.content_type, outdated: s.outdated, outdatedReason: s.outdated_reason || null, why: s.why || null })))) {
    const r = await db.insert(placementSeeds).values(rows).onConflictDoNothing();
    np += r.rowCount ?? 0;
  }
  out.placementSeeds = np;

  // Base prompt: first version only if none exists
  const existingBase = await db.select({ v: basePromptVersions.version }).from(basePromptVersions).limit(1);
  if (existingBase.length === 0) { await db.insert(basePromptVersions).values({ text: read("seed-base-prompt.md").trim(), note: "Stage 1 draft", createdBy: "seed" }); out.basePrompt = 1; }

  // Material types
  const types = JSON.parse(read("seed-material-types.json")) as { key: string; name: string; short: string; job: string; guide: string; rubric: [string, string][]; prompt_notes: string; links: number[] }[];
  let nt = 0, nr = 0;
  const typeRows = types.map((t, ti) => ({
    key: t.key, name: t.name, shortDescription: t.short, jobKey: t.job, sort: ti * 10,
    guideMd: t.guide, rubric: t.rubric.map(([criterion, description]) => ({ criterion, description })),
    reviewerNotes: t.prompt_notes, updatedBy: "seed",
  }));
  for (const rows of batches(typeRows)) {
    const inserted = await db.insert(materialTypes).values(rows).onConflictDoNothing().returning({ id: materialTypes.id, key: materialTypes.key });
    nt += inserted.length;
    const byKey = new Map(rows.map((t) => [t.key, t]));
    const versions = inserted.map((t) => {
      const original = byKey.get(t.key)!;
      return { typeId: t.id, version: 1, name: original.name, shortDescription: original.shortDescription, guideMd: original.guideMd, rubric: original.rubric, reviewerNotes: original.reviewerNotes, note: "Stage 1 draft", createdBy: "seed" };
    });
    if (versions.length) await db.insert(materialTypeVersions).values(versions).onConflictDoNothing();
  }
  for (const rows of batches(types.flatMap((t) => t.links.map((id, li) => ({ typeKey: t.key, sourceId: id, sort: li }))))) {
    const r = await db.insert(typeResourceSeeds).values(rows).onConflictDoNothing();
    nr += r.rowCount ?? 0;
  }
  out.materialTypes = nt; out.typeResourceSeeds = nr;
  await db.execute(sql`select 1`);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { console.log("Seed result", await seed()); } finally { await closeDb(); }
}
