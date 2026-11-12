import { describe, expect, it } from "vitest";
import { dropEmbeddedImages, hasEmbeddedImages, liftEmbeddedImages, mirrorImages, type InlineImage } from "./native.js";

const A = "https://lh7-rt.googleusercontent.com/docsz/AAA?key=1&amp;x=2", B = "https://lh7-rt.googleusercontent.com/docsz/BBB?key=1";
const html = `<p><img src="${A}" alt="Header"></p><p>Text</p><p><img src="${B}"></p><p><img src="${A}"></p><p><img src="/api/files/native/already"></p>`;
function io(bytes: Record<string, string | null>) {
  const fetched: string[] = []; const stored: string[] = [];
  return { fetched, stored, fetch: async (url: string) => { fetched.push(url); const b = bytes[url]; return b == null ? null : { buf: Buffer.from(b), mime: "image/png" }; }, store: async (_buf: Buffer, _mime: string, hash: string) => { stored.push(hash); return `drive${stored.length}`; } };
}

describe("keeping copies of a document's pictures", () => {
  it("stores each picture once and points the body at the copies", async () => {
    const x = io({ "https://lh7-rt.googleusercontent.com/docsz/AAA?key=1&x=2": "header-bytes", [B]: "diagram-bytes" });
    const r = await mirrorImages(html, [], x);
    expect(r.html).toBe('<p><img src="/api/files/native/drive1" alt="Header"></p><p>Text</p><p><img src="/api/files/native/drive2"></p><p><img src="/api/files/native/drive1"></p><p><img src="/api/files/native/already"></p>');
    expect(x.fetched).toEqual(["https://lh7-rt.googleusercontent.com/docsz/AAA?key=1&x=2", B]);
    expect(r.images.map((i) => i.driveId)).toEqual(["drive1", "drive2"]);
  });
  // Google gives a picture a new address on every export. Without this, every refresh would upload every picture again.
  it("uploads nothing when the pictures are the ones already kept, whatever address they come from", async () => {
    const first = await mirrorImages(html, [], io({ "https://lh7-rt.googleusercontent.com/docsz/AAA?key=1&x=2": "header-bytes", [B]: "diagram-bytes" }));
    const again = html.replace(/AAA/g, "NEW1").replace(/BBB/g, "NEW2");
    const x = io({ "https://lh7-rt.googleusercontent.com/docsz/NEW1?key=1&x=2": "header-bytes", "https://lh7-rt.googleusercontent.com/docsz/NEW2?key=1": "diagram-bytes" });
    const r = await mirrorImages(again, first.images as InlineImage[], x);
    expect(x.stored).toEqual([]);
    expect(r.html).toBe(first.html.replace(/drive(\d)/g, "drive$1"));
    expect(r.images).toEqual(first.images);
  });
  it("leaves a picture it cannot fetch at its original address and carries on", async () => {
    const x = io({ "https://lh7-rt.googleusercontent.com/docsz/AAA?key=1&x=2": null, [B]: "diagram-bytes" });
    const r = await mirrorImages(html, [], x);
    expect(r.html).toContain(`src="${A}"`);
    expect(r.html).toContain('src="/api/files/native/drive1"');
    expect(r.images).toHaveLength(1);
  });
  it("does nothing to a body with no remote pictures", async () => {
    const x = io({});
    const r = await mirrorImages('<p>Words</p><img src="/api/files/native/abc">', [], x);
    expect(x.fetched).toEqual([]); expect(r.html).toBe('<p>Words</p><img src="/api/files/native/abc">');
  });
  // Read through the Drive API, a Doc's pictures arrive as data inside the HTML, not as addresses.
  describe("pictures the export carries inside itself", () => {
    const png = Buffer.from("header-bytes").toString("base64");
    const doc = `<p><img alt="Header" src="data:image/png;base64,${png}"></p><p>Text</p><p><img src="data:image/svg+xml;base64,${png}"></p>`;
    it("swaps each for a stand-in address and keeps the bytes", () => {
      const l = liftEmbeddedImages(doc);
      expect(l.embedded.size).toBe(1);
      const [hash, img] = [...l.embedded][0]!;
      expect(img).toEqual({ buf: Buffer.from("header-bytes"), mime: "image/png" });
      expect(l.html).toContain(`<img alt="Header" src="https://embedded.wisdom.invalid/${hash}">`);
      // Not a raster type, so it is left for the sanitizer to drop.
      expect(l.html).toContain("data:image/svg+xml");
    });
    it("stores them without fetching, and once for the same picture", async () => {
      const l = liftEmbeddedImages(`<img src="data:image/png;base64,${png}"><img src="data:image/png;base64,${png}">`);
      const x = io({});
      const r = await mirrorImages(l.html, [], x, l.embedded);
      expect(x.fetched).toEqual([]); expect(x.stored).toHaveLength(1);
      expect(r.html).toBe('<img src="/api/files/native/drive1"><img src="/api/files/native/drive1">');
      expect(hasEmbeddedImages(r.html)).toBe(false);
      const again = await mirrorImages(l.html, r.images, x, l.embedded);
      expect(x.stored).toHaveLength(1); expect(again.html).toBe(r.html);
    });
    it("leaves a stand-in it has no bytes for, which the caller can drop", async () => {
      const l = liftEmbeddedImages(`<p>Words</p><p><img src="data:image/png;base64,${png}"></p>`);
      const r = await mirrorImages(l.html, [], io({}));
      expect(hasEmbeddedImages(r.html)).toBe(true);
      expect(dropEmbeddedImages(r.html)).toBe("<p>Words</p>");
    });
  });
});
