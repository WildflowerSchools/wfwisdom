import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { STAGES, type ItemSummary, type JobSummary } from "@wfw/shared";
import { api, fmtDate } from "../../api";
import { ErrorState, Loading, State } from "../../components/ui";

type Kind = "google" | "file" | "text" | "series";
type Sub = { key: string; name: string; jobName: string };
function useSubs(): Sub[] { const map = useQuery({ queryKey: ["map"], queryFn: () => api.get<{ jobs: JobSummary[] }>("/api/map") }); return map.data?.jobs.flatMap((j) => j.subjobs.map((s) => ({ key: s.key, name: s.name, jobName: j.name }))) ?? []; }

function PlacementPicker({ subs, chosen, setChosen, stages, setStages }: { subs: Sub[]; chosen: string[]; setChosen: (v: string[]) => void; stages: string[]; setStages: (v: string[]) => void }) {
  return <>
    <div><strong style={{ fontSize: ".85rem" }}>Where it lives on the map</strong> <span className="muted" style={{ fontSize: ".8rem" }}>(first pick is primary)</span><div className="inline-actions" style={{ marginTop: 6, flexWrap: "wrap" }}>{chosen.map((k) => <span key={k} className="wf-status wf-status-teal">{subs.find((s) => s.key === k)?.name ?? k} <button type="button" className="link-button small" onClick={() => setChosen(chosen.filter((x) => x !== k))} aria-label="Remove">×</button></span>)}<select value="" onChange={(e) => { if (e.target.value) setChosen([...chosen, e.target.value]); }}><option value="">Add to…</option>{subs.filter((s) => !chosen.includes(s.key)).map((s) => <option key={s.key} value={s.key}>{s.jobName} › {s.name}</option>)}</select></div></div>
    <div><strong style={{ fontSize: ".85rem" }}>Stages</strong><div className="chip-group" style={{ marginTop: 6 }}>{STAGES.map((s) => <button key={s.key} type="button" className={`chip${stages.includes(s.key) ? " on" : ""}`} onClick={() => setStages(stages.includes(s.key) ? stages.filter((x) => x !== s.key) : [...stages, s.key])}>{s.name}</button>)}</div></div>
  </>;
}

function SeriesBuilder({ ids, setIds }: { ids: { id: string; title: string }[]; setIds: (v: { id: string; title: string }[]) => void }) {
  const [q, setQ] = useState(""); const [results, setResults] = useState<ItemSummary[]>([]);
  useEffect(() => { if (q.trim().length < 2) { setResults([]); return; } const t = setTimeout(() => { api.get<{ results: ItemSummary[] }>(`/api/admin/item-search?q=${encodeURIComponent(q.trim())}`).then((r) => setResults(r.results.slice(0, 8))).catch(() => setResults([])); }, 250); return () => clearTimeout(t); }, [q]);
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= ids.length) return; const next = [...ids]; [next[i], next[j]] = [next[j]!, next[i]!]; setIds(next); };
  return <div className="series-builder"><strong style={{ fontSize: ".85rem" }}>Items in this series, in order</strong>
    {ids.length ? <ol>{ids.map((it, i) => <li key={it.id}><span className="grow">{it.title}</span><button type="button" className="small" onClick={() => move(i, -1)} aria-label="Move up">↑</button><button type="button" className="small" onClick={() => move(i, 1)} aria-label="Move down">↓</button><button type="button" className="link-button small" onClick={() => setIds(ids.filter((x) => x.id !== it.id))}>Remove</button></li>)}</ol> : <p className="muted" style={{ fontSize: ".85rem" }}>Nothing yet. Search for items to add.</p>}
    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items to add" style={{ width: "100%", border: "1px solid var(--wf-border)", borderRadius: 7, padding: "8px 10px" }} />
    {results.length ? <ul className="wf-list tight" style={{ fontSize: ".875rem", marginTop: 6 }}>{results.filter((r) => !ids.some((x) => x.id === r.id)).map((r) => <li key={r.id}><button type="button" className="link-button" onClick={() => { setIds([...ids, { id: r.id, title: r.title }]); setQ(""); setResults([]); }}>+ {r.title}</button></li>)}</ul> : null}
  </div>;
}

/** Add a resource: a Google file (the usual way), an upload, text written here, or a series. */
export function AdminResourceNew() {
  const nav = useNavigate(); const subs = useSubs();
  const [kind, setKind] = useState<Kind>("google"); const [url, setUrl] = useState(""); const [title, setTitle] = useState(""); const [desc, setDesc] = useState(""); const [md, setMd] = useState(""); const [file, setFile] = useState<File | null>(null); const [children, setChildren] = useState<{ id: string; title: string }[]>([]); const [chosen, setChosen] = useState<string[]>([]); const [stages, setStages] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const create = useMutation({ mutationFn: () => { const fd = new FormData(); fd.set("kind", kind); if (title.trim()) fd.set("title", title.trim()); if (desc.trim()) fd.set("description", desc.trim()); if (kind === "google") fd.set("url", url.trim()); if (kind === "file" && file) fd.set("file", file); if (kind === "text") fd.set("bodyMarkdown", md); if (kind === "series") fd.set("childItemIds", JSON.stringify(children.map((c) => c.id))); fd.set("subjobKeys", JSON.stringify(chosen)); fd.set("stages", JSON.stringify(stages)); return api.form<{ id: string }>("/api/admin/native", fd); }, onSuccess: (r) => nav(`/item/${r.id}`) });
  const ok = kind === "google" ? /google\.com\//.test(url) : kind === "file" ? !!file : kind === "text" ? !!title.trim() && md.trim().length > 10 : !!title.trim() && children.length > 0;
  return (
    <div className="resource-editor">
      <div className="wf-card wf-card-section">
        <div className="kind-tabs">{([["google", "Google Doc, Sheet, or Slides"], ["file", "Upload a file"], ["text", "Write it here"], ["series", "A series"]] as [Kind, string][]).map(([k, l]) => <button key={k} type="button" className={kind === k ? "active" : ""} onClick={() => setKind(k)}>{l}</button>)}</div>
        {kind === "google" ? <><label className="field"><span>Google link</span><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.google.com/document/d/…" /></label><p className="muted" style={{ fontSize: ".85rem" }}>The document stays in Google and is the place to edit it. Keep it in the Wisdom shared drive folder, or share it with the service account, so it can be read and refreshed.</p></> : null}
        {kind === "file" ? <><div className="dropzone" style={{ padding: 20 }}><p style={{ margin: "0 0 8px" }}>{file ? <strong>{file.name}</strong> : "Word, PowerPoint, Excel, PDF, images, or video"}</p><button type="button" className="small" onClick={() => fileRef.current?.click()}>Choose file</button><input ref={fileRef} type="file" style={{ display: "none" }} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div><p className="muted" style={{ fontSize: ".85rem" }}>The file goes into the Wisdom Drive folder. Word, PowerPoint, and Excel files convert to Google Docs, Slides, and Sheets so editing continues in Google; PDFs and media stay as files.</p></> : null}
        {kind === "text" ? <label className="field"><span>Text (Markdown: # headings, **bold**, - lists, links)</span><textarea value={md} onChange={(e) => setMd(e.target.value)} placeholder="Write here. Use this for short guidance, a series introduction, or anything that has no home in Google." /></label> : null}
        {kind === "series" ? <SeriesBuilder ids={children} setIds={setChildren} /> : null}
        {create.error ? <State kind="error" title="Could not add it">{(create.error as Error).message}</State> : null}
      </div>
      <aside className="wf-card wf-card-section" style={{ display: "grid", gap: 12 }}>
        <label className="field"><span>Title{kind === "google" || kind === "file" ? " (optional; the file's own title is used)" : ""}</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></label>
        <label className="field"><span>One-line description</span><input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={600} placeholder="What it is and when to use it" /></label>
        <PlacementPicker subs={subs} chosen={chosen} setChosen={setChosen} stages={stages} setStages={setStages} />
        <button type="button" className="primary-button" disabled={!ok || create.isPending} onClick={() => create.mutate()}>{create.isPending ? "Adding…" : "Add to Wildflower Wisdom"}</button>
      </aside>
    </div>
  );
}

type Detail = { item: { id: string; title: string; description: string | null; url: string; status: string; nativeKind: Kind; googleKind: string | null; googleFileId: string | null; driveMime: string | null; bodyMarkdown: string | null; childItemIds: string[]; nativeModifiedAt: string | null; language: string; introHtml: string | null; nativeAttachments: { driveId: string; name: string; mime: string | null; bytes: number; kind: string }[]; importedFrom: { kind: string; sourceId: number } | null; importedAt: string | null }; versions: { id: string; version: number; title: string; createdAt: string; createdBy: string | null; sourceModifiedAt: string | null; chars: number }[]; placements: { key: string; name: string; jobName: string; isPrimary: boolean }[]; stages: string[]; children: { id: string; title: string }[] };

/** Edit a native resource: its title, placement, text or series, and its version history. */
export function AdminResourceEdit() {
  const { id } = useParams(); const qc = useQueryClient(); const subs = useSubs(); const nav = useNavigate();
  const q = useQuery({ queryKey: ["admin-native", id], queryFn: () => api.get<Detail>(`/api/admin/native/${id}`) });
  const [title, setTitle] = useState(""); const [desc, setDesc] = useState(""); const [md, setMd] = useState(""); const [url, setUrl] = useState(""); const [children, setChildren] = useState<{ id: string; title: string }[]>([]); const [chosen, setChosen] = useState<string[]>([]); const [stages, setStages] = useState<string[]>([]); const [lang, setLang] = useState("unknown"); const [loaded, setLoaded] = useState(false);
  useEffect(() => { if (q.data && !loaded) { const d = q.data; setTitle(d.item.title); setDesc(d.item.description ?? ""); setMd(d.item.bodyMarkdown ?? ""); setChildren(d.children); setChosen(d.placements.map((p) => p.key)); setStages(d.stages); setLang(d.item.language); setLoaded(true); } }, [q.data, loaded]);
  const inv = () => { qc.invalidateQueries({ queryKey: ["admin-native", id] }); qc.invalidateQueries({ queryKey: ["item", id] }); };
  const save = useMutation({ mutationFn: () => api.patch(`/api/admin/native/${id}`, { title, description: desc || null, bodyMarkdown: q.data?.item.nativeKind === "text" ? md : undefined, childItemIds: q.data?.item.nativeKind === "series" ? children.map((c) => c.id) : undefined, url: url.trim() || undefined, subjobKeys: chosen, stages, language: lang }), onSuccess: () => { setUrl(""); inv(); } });
  const refresh = useMutation({ mutationFn: () => api.post<{ changed: boolean; status: string }>(`/api/admin/native/${id}/refresh`), onSuccess: inv });
  const restore = useMutation({ mutationFn: (v: number) => api.post(`/api/admin/native/${id}/versions/${v}/restore`), onSuccess: inv });
  const remove = useMutation({ mutationFn: () => api.del(`/api/admin/native/${id}`), onSuccess: () => nav("/admin/curation") });
  const toGoogle = useMutation({ mutationFn: () => api.post<{ url: string | null }>(`/api/admin/native/${id}/to-google`), onSuccess: () => { setLoaded(false); inv(); } });
  const detach = useMutation({ mutationFn: () => api.post<{ formerGoogleUrl: string; pictures: number; tables: number }>(`/api/admin/native/${id}/detach`), onSuccess: () => { setLoaded(false); inv(); } });
  const dropFile = useMutation({ mutationFn: (driveId: string) => api.patch(`/api/admin/native/${id}`, { removeAttachment: driveId }), onSuccess: inv });
  const clearIntro = useMutation({ mutationFn: () => api.patch(`/api/admin/native/${id}`, { introHtml: null }), onSuccess: inv });
  if (q.isLoading || !loaded) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data!; const k = d.item.nativeKind;
  return (
    <div className="resource-editor">
      <div style={{ display: "grid", gap: 16 }}>
        <div className="wf-card wf-card-section" style={{ display: "grid", gap: 12 }}>
          <div className="wf-section-header" style={{ margin: 0 }}><div><p className="eyebrow" style={{ margin: 0 }}>{k === "google" ? "Linked · " : k === "text" || k === "file" ? "Held in Wisdom · " : ""}{k === "google" ? `Google ${d.item.googleKind === "spreadsheets" ? "Sheet" : d.item.googleKind === "presentation" ? "Slides" : d.item.googleKind === "document" ? "Doc" : "file"}` : k === "file" ? "File in Drive" : k === "text" ? "Written here" : "Series"} · {d.item.status}</p><h2 style={{ margin: "2px 0 0" }}><Link to={`/item/${d.item.id}`}>{d.item.title}</Link></h2></div><div className="inline-actions">{k === "google" || k === "file" ? <><a href={d.item.url} target="_blank" rel="noreferrer">Open in Google ↗</a><button type="button" className="small" disabled={refresh.isPending} onClick={() => refresh.mutate()}>{refresh.isPending ? "Reading…" : "Refresh from Google"}</button></> : null}</div></div>
          {/* One place to edit each resource, said outright, so nobody keeps a second copy up to date by hand. */}
          {k === "google" ? <p className="muted" style={{ fontSize: ".85rem", margin: 0 }}>This resource is its Google file. Edit it in Google; Wisdom re-reads it when it changes, on the next visit and every night.{d.item.googleKind === "document" ? <> To edit it here instead, <button type="button" className="link-button" disabled={detach.isPending} onClick={() => { if (confirm("Hold this in Wisdom? Its text, tables and pictures come in as a page you edit here. Changes to the Google Doc will no longer appear, and the Google file is left where it is for you to remove.")) detach.mutate(); }}>{detach.isPending ? "bringing it in…" : "hold it in Wisdom"}</button>.</> : null}{detach.error ? <span className="wf-status wf-status-error"> {(detach.error as Error).message}</span> : null}</p> : null}
          {detach.data ? <State kind="success" title="Now held in Wisdom">Brought in with {detach.data.pictures} picture{detach.data.pictures === 1 ? "" : "s"} and {detach.data.tables} table{detach.data.tables === 1 ? "" : "s"}. The <a href={detach.data.formerGoogleUrl} target="_blank" rel="noreferrer">Google Doc</a> is no longer connected; remove it so there is one copy.</State> : null}
          {refresh.data ? <State kind={refresh.data.status === "ok" ? "success" : "error"} title={refresh.data.status === "ok" ? (refresh.data.changed ? "Updated from Google" : "Already current") : `Could not read it (${refresh.data.status})`} /> : null}
          <div className="field-row"><label className="field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label><label className="field"><span>One-line description</span><input value={desc} onChange={(e) => setDesc(e.target.value)} /></label></div>
          {k === "google" ? <label className="field"><span>Point at a different Google file (optional)</span><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a new Google link to replace the current one" /></label> : null}
          {d.item.importedFrom ? <p className="muted" style={{ fontSize: ".85rem", margin: 0 }}>Imported from Connected ({d.item.importedFrom.kind} {d.item.importedFrom.sourceId}){d.item.importedAt ? ` on ${fmtDate(d.item.importedAt)}` : ""}. Its files are in the Wisdom Drive folder under "Connected import".</p> : null}
          {d.item.introHtml ? <div className="field"><span style={{ display: "flex", justifyContent: "space-between" }}><span>Intro shown above the content{d.item.importedFrom ? " (the post's own words from Connected)" : ""}</span><button type="button" className="link-button small" onClick={() => { if (confirm("Remove the intro? The files and the main content stay.")) clearIntro.mutate(); }}>Remove intro</button></span><div className="wf-doc" style={{ border: "1px solid var(--wf-border)", borderRadius: 7, padding: "8px 12px", maxHeight: 240, overflow: "auto", fontSize: ".9rem" }} dangerouslySetInnerHTML={{ __html: d.item.introHtml }} /></div> : null}
          {k === "text" ? <><label className="field"><span>Text (Markdown; tables as | a | b | rows, pictures as ![description](address)){d.item.introHtml ? " — shown under the intro" : ""}</span><textarea value={md} onChange={(e) => setMd(e.target.value)} /></label><p className="muted" style={{ fontSize: ".85rem", margin: 0 }}>This page is the record: what you save here is what readers see. To edit it in Google instead, <button type="button" className="link-button" disabled={toGoogle.isPending} onClick={() => { if (confirm("Turn this page into a Google Doc? The intro and text move into a new Doc in the Wisdom folder, and this item then reads from it. From then on you edit it in Google, not here.")) toGoogle.mutate(); }}>{toGoogle.isPending ? "converting…" : "turn it into a Google Doc"}</button>.{toGoogle.error ? <span className="wf-status wf-status-error"> {(toGoogle.error as Error).message}</span> : null}</p></> : null}
          {d.item.nativeAttachments?.length ? <div className="field"><span>Files shown with this item</span><ul className="wf-list tight" style={{ fontSize: ".875rem" }}>{d.item.nativeAttachments.map((a) => <li key={a.driveId} style={{ display: "flex", gap: 8, alignItems: "center" }}><a href={`/api/files/native/${a.driveId}`} target="_blank" rel="noreferrer" className="grow">{a.name}</a><span className="muted">{a.kind}{a.bytes ? ` · ${(a.bytes / 1024 / 1024).toFixed(1)} MB` : ""}</span><button type="button" className="link-button small" onClick={() => { if (confirm(`Stop showing ${a.name} with this item? The file stays in Drive.`)) dropFile.mutate(a.driveId); }}>Remove</button></li>)}</ul></div> : null}
          {k === "series" ? <SeriesBuilder ids={children} setIds={setChildren} /> : null}
          <label className="field" style={{ maxWidth: 240 }}><span>Language</span><select value={lang} onChange={(e) => setLang(e.target.value)}><option value="en">English</option><option value="es">Spanish</option><option value="unknown">Unknown</option></select></label>
          {save.error ? <State kind="error" title="Could not save">{(save.error as Error).message}</State> : null}
          <div className="wf-form-actions"><button type="button" className="danger" onClick={() => { if (confirm("Remove this resource from Wildflower Wisdom? The Google file is not touched.")) remove.mutate(); }}>Remove</button><span style={{ flex: 1 }} /><button type="button" className="primary-button" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save"}</button></div>
        </div>
        <div className="wf-card wf-card-section"><h3 style={{ marginTop: 0 }}>Versions</h3><p className="muted" style={{ fontSize: ".85rem" }}>A snapshot is kept each time the content changes, so an overwritten document can be brought back. Restoring a Google file creates a new Google Doc from the snapshot and points this item at it; the current file is left as is.</p>
          {d.versions.length ? <table className="wf-table"><thead><tr><th>Version</th><th>Saved</th><th>By</th><th>Size</th><th></th></tr></thead><tbody>{d.versions.map((v) => <tr key={v.id}><td>v{v.version}</td><td>{fmtDate(v.createdAt)}{v.sourceModifiedAt ? <small className="muted"> · edited in Google {fmtDate(v.sourceModifiedAt)}</small> : null}</td><td>{v.createdBy ?? "—"}</td><td>{v.chars.toLocaleString()} chars</td><td>{d.versions[0]?.id !== v.id && (k === "text" || k === "google") ? <button type="button" className="small" disabled={restore.isPending} onClick={() => { if (confirm(`Restore version ${v.version}?`)) restore.mutate(v.version); }}>Restore</button> : null}</td></tr>)}</tbody></table> : <p className="muted">No snapshots yet.</p>}
          {restore.error ? <State kind="error" title="Could not restore">{(restore.error as Error).message}</State> : null}
        </div>
      </div>
      <aside className="wf-card wf-card-section" style={{ display: "grid", gap: 12 }}>
        <PlacementPicker subs={subs} chosen={chosen} setChosen={setChosen} stages={stages} setStages={setStages} />
        <p className="muted" style={{ fontSize: ".8rem", margin: 0 }}>Curation (Essential, Staff pick, pins, hide) is on the Curation page like every other item.</p>
      </aside>
    </div>
  );
}
