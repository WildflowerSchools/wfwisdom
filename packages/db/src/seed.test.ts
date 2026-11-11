import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Db } from "./index.js";
import { seed } from "./seed.js";
import { basePromptVersions, jobs, materialTypes, materialTypeVersions, placementSeeds, settings, subjobs, taxonomyRetirements, typeResourceSeeds } from "./schema.js";

type Row = Record<string, unknown>;
const taxonomy = JSON.parse(readFileSync(new URL("../seed-taxonomy.json", import.meta.url), "utf8")) as {
  jobs: { key: string; subs: { key: string }[] }[];
};
const types = JSON.parse(readFileSync(new URL("../seed-material-types.json", import.meta.url), "utf8")) as { key: string }[];
const placements = JSON.parse(readFileSync(new URL("../seed-placements.json", import.meta.url), "utf8")) as unknown[];

/** Only the insert-if-missing operations used by seed; unexpected operations fail the test. */
function memoryDb() {
  const rows = new Map<object, Row[]>();
  const keys = new Map<object, string[]>([
    [settings, ["key"]], [jobs, ["key"]], [subjobs, ["key"]],
    [placementSeeds, ["sourceKind", "sourceId"]], [materialTypes, ["key"]],
    [materialTypeVersions, ["typeId", "version"]], [typeResourceSeeds, ["typeKey", "sourceId"]],
  ]);
  const statements: { table: object; size: number }[] = [];
  const data = (table: object) => {
    if (!rows.has(table)) rows.set(table, []);
    return rows.get(table)!;
  };
  const db = {
    insert: (table: object) => ({
      values: (input: Row | Row[]) => {
          const values = Array.isArray(input) ? input : [input];
          assert.ok(values.length > 0, "never issue an empty INSERT");
          statements.push({ table, size: values.length });
          const inserted: Row[] = [];
          for (const row of values) {
            const columns = keys.get(table) ?? [];
            if (columns.length && data(table).some((old) => columns.every((k) => old[k] === row[k]))) continue;
            const next = { id: `id-${data(table).length}`, ...row };
            data(table).push(next);
            inserted.push(next);
          }
          const result = Object.assign(Promise.resolve({ rowCount: inserted.length }), {
            returning: async () => inserted,
          });
          return Object.assign(result, { onConflictDoNothing: () => result });
      },
    }),
    select: () => ({
      from: (table: object) => Object.assign(Promise.resolve(data(table)), {
        limit: async (n: number) => data(table).slice(0, n),
      }),
    }),
    execute: async () => undefined,
  } as unknown as Db;
  return { db, data, statements };
}

test("seeds a fresh database in bounded batches, then does nothing on replay", async () => {
  const { db, data, statements } = memoryDb();
  const first = await seed(db);
  assert.equal(first.placementSeeds, placements.length);
  assert.equal(first.jobs, taxonomy.jobs.length);
  assert.equal(first.subjobs, taxonomy.jobs.reduce((n, j) => n + j.subs.length, 0));
  assert.equal(first.materialTypes, types.length);
  assert.equal(data(materialTypeVersions).length, types.length);
  assert.ok(data(subjobs).every((s) => data(jobs).some((j) => j.id === s.jobId)));
  assert.ok(data(materialTypeVersions).every((v) => data(materialTypes).some((t) => t.id === v.typeId)));
  assert.ok(statements.every((s) => s.size <= 200));
  assert.equal(statements.filter((s) => s.table === placementSeeds).length, Math.ceil(placements.length / 200));
  assert.ok(statements.length < 25, `expected fewer than 25 inserts, got ${statements.length}`);
  const snapshot = structuredClone([...new Set(statements.map((s) => s.table))].map((t) => data(t)));
  const second = await seed(db);
  assert.ok(Object.values(second).every((count) => count === 0), JSON.stringify(second));
  assert.equal(data(basePromptVersions).length, 1);
  assert.deepEqual([...new Set(statements.map((s) => s.table))].map((t) => data(t)), snapshot);
});

test("preserves staff edits, applied placement seeds, and retired taxonomy", async () => {
  const { db, data } = memoryDb();
  const retiredJob = taxonomy.jobs[0]!;
  const activeJob = taxonomy.jobs[1]!;
  const retiredSubjob = activeJob.subs[0]!;
  data(taxonomyRetirements).push({ kind: "job", key: retiredJob.key }, { kind: "subjob", key: retiredSubjob.key });
  data(jobs).push({ id: "staff-job", key: activeJob.key, name: "Staff name", hidden: true });
  data(settings).push({ key: "staffDomain", value: "staff.example" });
  data(materialTypes).push({ id: "staff-type", key: types[0]!.key, name: "Staff type" });
  const existing = { job: structuredClone(data(jobs)[0]), setting: structuredClone(data(settings)[0]), type: structuredClone(data(materialTypes)[0]) };
  await seed(db);
  assert.deepEqual(data(jobs).find((j) => j.id === "staff-job"), existing.job);
  assert.deepEqual(data(settings)[0], existing.setting);
  assert.deepEqual(data(materialTypes).find((t) => t.id === "staff-type"), existing.type);
  assert.ok(!data(materialTypeVersions).some((v) => v.typeId === "staff-type"));
  assert.ok(!data(jobs).some((j) => j.key === retiredJob.key));
  assert.ok(!data(subjobs).some((s) => s.key === retiredSubjob.key || retiredJob.subs.some((r) => r.key === s.key)));
  data(placementSeeds)[0]!.applied = true;
  await seed(db);
  assert.equal(data(placementSeeds)[0]!.applied, true);
});

test("database failures are propagated instead of reporting successful seeding", async () => {
  const { db } = memoryDb();
  db.insert = (() => { throw new Error("database unavailable"); }) as Db["insert"];
  await assert.rejects(seed(db), /database unavailable/);
});
