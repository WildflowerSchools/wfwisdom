import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./tools.js";
import { staffUser, teacher } from "../routes/test-app.js";

async function connect(user: typeof teacher) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([buildServer(user).connect(a), client.connect(b)]);
  return client;
}

describe("connector tools", () => {
  // The staff tools change what every teacher leader sees, so a teacher leader's connection must not
  // merely refuse them: it must not carry them at all.
  it("gives a teacher leader no staff tools", async () => {
    const names = (await (await connect(teacher)).listTools()).tools.map((t) => t.name);
    expect(names).toContain("search_wisdom");
    expect(names.filter((n) => n.startsWith("staff_"))).toEqual([]);
  });
  it("gives staff the reader tools and the staff tools", async () => {
    const names = (await (await connect(staffUser)).listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_wisdom", "log_question", "staff_gap_report", "staff_update_resource", "staff_move_resource"]));
  });
  it("refuses a staff tool called on a teacher leader's connection", async () => {
    const client = await connect(teacher);
    const r = await client.callTool({ name: "staff_update_resource", arguments: { id: "11111111-1111-4111-8111-111111111111", hidden: true } }).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }));
    expect(r.isError).toBe(true);
  });
  // The question in the asker's own words is what keeps the log meaningful once Claude writes the search terms.
  it("requires the question on every search", async () => {
    const tools = (await (await connect(teacher)).listTools()).tools;
    const search = tools.find((t) => t.name === "search_wisdom")!;
    expect(search.inputSchema.required).toEqual(["question"]);
  });
  // Approving publishes to the whole network; a teacher leader can offer a resource but never decide one.
  it("lets a teacher leader contribute but not approve", async () => {
    const names = (await (await connect(teacher)).listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["create_resource", "share_resource", "request_upload_link", "my_contributions"]));
    expect(names).not.toContain("staff_review_contribution");
  });
  it("marks tools that only read as read-only, and the rest as not", async () => {
    const tools = (await (await connect(staffUser)).listTools()).tools;
    const readOnly = (n: string) => tools.find((t) => t.name === n)!.annotations?.readOnlyHint;
    for (const n of ["search_wisdom", "get_resource", "browse_map", "whats_new", "get_review_guide", "staff_gap_report"]) expect(readOnly(n)).toBe(true);
    for (const n of ["log_question", "share_resource", "create_resource", "request_upload_link", "set_my_stage", "staff_update_resource", "staff_move_resource", "staff_review_contribution"]) expect(readOnly(n)).toBe(false);
  });
});
