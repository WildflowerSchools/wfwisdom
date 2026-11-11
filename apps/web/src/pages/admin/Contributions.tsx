import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { STAGES, type JobSummary } from "@wfw/shared";
import { api, fmtDate } from "../../api";
import { ErrorState, Loading, State } from "../../components/ui";

type Row = { id: string; title: string; description: string | null; url: string; status: string; nativeKind: string; googleKind: string | null; materialTypeKey: string | null; contributionNote: string | null; declineNote: string | null; createdAt: string; authorName: string | null; authorEmail: string | null; bodyText: string };

/** Materials teacher leaders shared, waiting for a staff decision. */
export function AdminContributions() {
  const qc = useQueryClient(); const [status, setStatus] = useState("pending"); const [openId, setOpenId] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["admin-contributions", status], queryFn: () => api.get<{ contributions: Row[]; types: { key: string; name: string; jobKey: string | null }[] }>(`/api/admin/native/contributions?status=${status}`) });
  const map = useQuery({ queryKey: ["map"], queryFn: () => api.get<{ jobs: JobSummary[] }>("/api/map") });
  const inv = () => { qc.invalidateQueries({ queryKey: ["admin-contributions"] }); qc.invalidateQueries({ queryKey: ["admin-overview"] }); };
  const approve = useMutation({ mutationFn: ({ id, ...b }: { id: string; subjobKeys: string[]; stages: string[]; title?: string; description?: string | null; copyToWisdom?: boolean }) => api.post(`/api/admin/native/contributions/${id}/approve`, b), onSuccess: inv });
  const decline = useMutation({ mutationFn: ({ id, note }: { id: string; note: string }) => api.post(`/api/admin/native/contributions/${id}/decline`, { note }), onSuccess: inv });
  if (q.isLoading || map.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const subs = map.data?.jobs.flatMap((j) => j.subjobs.map((s) => ({ key: s.key, name: s.name, jobKey: j.key, jobName: j.name }))) ?? [];
  const rows = q.data!.contributions; const types = q.data!.types;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="chip-group" role="group" aria-label="Status">{[["pending", "Waiting"], ["published", "Published"], ["declined", "Not added"], ["all", "All"]].map(([k, l]) => <button key={k} type="button" className={`chip${status === k ? " on" : ""}`} onClick={() => setStatus(k!)}>{l}</button>)}</div>
      {rows.length === 0 ? <State kind="empty" title="Nothing waiting">Materials shared from the Share your materials page show up here.</State> : rows.map((r) => <Review key={r.id} r={r} open={openId === r.id} setOpen={() => setOpenId(openId === r.id ? null : r.id)} subs={subs} types={types} onApprove={(b) => approve.mutate({ id: r.id, ...b })} onDecline={(note) => decline.mutate({ id: r.id, note })} busy={approve.isPending || decline.isPending} />)}
      {approve.error ? <ErrorState error={approve.error} /> : null}
    </div>
  );
}

function Review({ r, open, setOpen, subs, types, onApprove, onDecline, busy }: { r: Row; open: boolean; setOpen: () => void; subs: { key: string; name: string; jobKey: string; jobName: string }[]; types: { key: string; name: string; jobKey: string | null }[]; onApprove: (b: { subjobKeys: string[]; stages: string[]; title?: string; description?: string | null; copyToWisdom?: boolean }) => void; onDecline: (note: string) => void; busy: boolean }) {
  const type = types.find((t) => t.key === r.materialTypeKey);
  const suggested = subs.filter((s) => s.jobKey === type?.jobKey).map((s) => s.key);
  const [title, setTitle] = useState(r.title); const [desc, setDesc] = useState(r.description ?? ""); const [chosen, setChosen] = useState<string[]>(suggested.slice(0, 1)); const [stages, setStages] = useState<string[]>([]); const [note, setNote] = useState(""); const [copy, setCopy] = useState(true);
  const toggle = (arr: string[], set: (v: string[]) => void, k: string) => set(arr.includes(k) ? arr.filter((x) => x !== k) : [...arr, k]);
  return (
    <div className="wf-card wf-card-section">
      <div className="wf-section-header" style={{ margin: 0 }}><div><p className="eyebrow" style={{ margin: 0 }}>{type ? type.name : "Other resource"} · {r.nativeKind === "google" ? `Google ${r.googleKind === "spreadsheets" ? "Sheet" : r.googleKind === "presentation" ? "Slides" : r.googleKind === "document" ? "Doc" : "file"}` : "Uploaded file"}</p><h3 style={{ margin: "2px 0 4px" }}>{r.status === "published" ? <Link to={`/item/${r.id}`}>{r.title}</Link> : r.title}</h3><div className="muted" style={{ fontSize: ".85rem" }}>From {r.authorName ?? "unknown"}{r.authorEmail ? ` (${r.authorEmail})` : ""} · {fmtDate(r.createdAt)} · <a href={r.url} target="_blank" rel="noreferrer">open the original ↗</a></div></div>
        <div className="inline-actions">{r.status === "pending" ? <button type="button" className="primary-button" onClick={setOpen}>{open ? "Close" : "Review"}</button> : <span className={`wf-status wf-status-${r.status === "published" ? "complete" : "danger"}`}>{r.status === "published" ? "Published" : "Not added"}</span>}</div></div>
      {r.contributionNote ? <blockquote className="feedback-quote" style={{ marginTop: 10 }}>{r.contributionNote}</blockquote> : null}
      {r.bodyText ? <p className="muted" style={{ fontSize: ".85rem", marginTop: 10 }}>{r.bodyText}{r.bodyText.length >= 600 ? "…" : ""}</p> : <p className="muted" style={{ fontSize: ".85rem", marginTop: 10 }}>No text could be read yet (a private Google file, or a file without text). Open the original to check it.</p>}
      {open ? <div style={{ display: "grid", gap: 12, marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--wf-border)" }}>
        <div className="field-row"><label className="field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label><label className="field"><span>One-line description</span><input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What it is and when to use it" /></label></div>
        <div><strong style={{ fontSize: ".85rem" }}>Where it lives on the map</strong> <span className="muted" style={{ fontSize: ".8rem" }}>(first pick is primary)</span><div className="inline-actions" style={{ marginTop: 6, flexWrap: "wrap" }}>{chosen.map((k) => <span key={k} className="wf-status wf-status-teal">{subs.find((s) => s.key === k)?.name ?? k} <button type="button" className="link-button small" onClick={() => setChosen(chosen.filter((x) => x !== k))} aria-label="Remove">×</button></span>)}<select value="" onChange={(e) => { if (e.target.value) setChosen([...chosen, e.target.value]); }}><option value="">Add to…</option>{subs.filter((s) => !chosen.includes(s.key)).map((s) => <option key={s.key} value={s.key}>{s.jobName} › {s.name}</option>)}</select></div></div>
        <div><strong style={{ fontSize: ".85rem" }}>Stages</strong><div className="chip-group" style={{ marginTop: 6 }}>{STAGES.map((s) => <button key={s.key} type="button" className={`chip${stages.includes(s.key) ? " on" : ""}`} onClick={() => toggle(stages, setStages, s.key)}>{s.name}</button>)}</div></div>
        {/* A linked resource shows whatever its file says. Copying on approval keeps the contributor's later edits from publishing unreviewed. */}
        {r.nativeKind === "google" ? <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: ".875rem" }}><input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} style={{ marginTop: 3 }} /><span><strong>Copy into the Wisdom Drive</strong> and link to the copy. <span className="muted">Untick only if the contributor will keep this file up to date: Wisdom then shows whatever they change in it, without review, and loses it if they delete it.</span></span></label> : null}
        <div className="wf-form-actions" style={{ gap: 10 }}><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="If declining, a short note for the contributor" style={{ flex: 1, border: "1px solid var(--wf-border)", borderRadius: 7, padding: "8px 10px" }} /><button type="button" disabled={busy} onClick={() => onDecline(note)}>Decline</button><button type="button" className="primary-button" disabled={busy || !chosen.length} onClick={() => onApprove({ subjobKeys: chosen, stages, title, description: desc || null, copyToWisdom: copy })}>{busy ? "Working…" : "Publish on the map"}</button></div>
      </div> : null}
    </div>
  );
}
