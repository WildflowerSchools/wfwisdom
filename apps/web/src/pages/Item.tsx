import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, Flag, Info, Pencil, ThumbsDown, ThumbsUp } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { creditLine, type ItemSummary } from "@wfw/shared";
import { api, fmtDate } from "../api";
import { ErrorState, ItemGrid, Linkify, Loading, Pill, RegionTags } from "../components/ui";
import { useMe } from "../me";

type Attachment = { key: string; src: string; name: string; kind: string; bytes: number; mime: string | null; openUrl: string | null };
type LinkedDoc = { url: string; kind: string; status: string };
type Detail = {
  item: ItemSummary & { authorName: string | null; reviewedAt: string | null; reviewedBy: string | null; flagged: boolean; publishedAt: string | null; categories: string[]; audiences: string[]; bodyHtml: string; primaryVideo: Attachment | null; attachments: Attachment[]; linkedDocs: LinkedDoc[]; contents: ItemSummary[]; seriesNav: { seriesId: string; seriesTitle: string; posts: { id: string; title: string; current: boolean }[] }[]; native: { kind: string | null; googleKind: string | null; googleFileId: string | null; status: string; author: { id: string; name: string } | null; imported: boolean } | null; importError: string | null };
  placements: { key: string; name: string; jobName: string; jobKey: string; isPrimary: boolean }[];
  votes: { yes: number; no: number; mine: string | null };
};

const mb = (b: number) => (b ? ` · ${(b / 1024 / 1024).toFixed(1)} MB` : "");
const docLabel = (k: string) => (k === "spreadsheets" ? "Google Sheet" : k === "presentation" ? "Google Slides" : "Google Doc");
const embedUrl = (d: LinkedDoc) => { const m = d.url.match(/\/d\/([A-Za-z0-9_-]+)/); const id = m?.[1] ?? ""; return d.kind === "presentation" ? `https://docs.google.com/presentation/d/${id}/embed?start=false&loop=false` : `https://docs.google.com/${d.kind}/d/${id}/preview`; };

function Media({ a }: { a: Attachment }) {
  return (
    <figure className="wf-media">
      {a.kind === "image" ? <img src={a.src} alt={a.name} loading="lazy" />
        : a.kind === "video" ? <video src={a.src} controls preload="metadata" />
        : a.kind === "audio" ? <audio src={a.src} controls preload="metadata" style={{ width: "100%" }} />
        : a.kind === "document" ? <iframe src={a.src} title={a.name} loading="lazy" />
        : null}
      <figcaption className="caption"><strong>{a.name}</strong><span className="muted">{a.kind}{mb(a.bytes)}</span>{a.openUrl ? <a href={a.openUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open in Google</a> : null}<a href={`${a.src}?download=1`}><Download size={14} /> Download</a></figcaption>
    </figure>
  );
}

/**
 * Why a page has nothing on it. "Is the source empty or did the import fail?" is the first question a
 * blank page raises, so it answers that rather than stating the obvious.
 */
function EmptyBody({ item }: { item: Detail["item"] }) {
  const external = item.url && !item.url.startsWith("/");
  const why = item.importError
    ? `The last attempt to bring this across failed: ${item.importError}`
    : item.kind === "question"
    ? "This question was asked in Connected but carries no explanation of its own, and nobody has answered it yet."
    : "There is nothing stored for this beyond its title — no text, files or links. It is empty at the source rather than having failed to come across.";
  return (
    <div className="wf-state">
      <span className="wf-state-icon"><Info size={20} /></span>
      <div><strong>Nothing to show here yet</strong><p>{why}{external ? <> <a href={item.url} target="_blank" rel="noreferrer">Open it at the source</a> to check.</> : null}</p></div>
    </div>
  );
}

export function ItemPage() {
  const { id } = useParams(); const qc = useQueryClient(); const me = useMe();
  const q = useQuery({ queryKey: ["item", id], queryFn: () => api.get<Detail>(`/api/map/item/${id}`) });
  // A flag carries an optional note, so the button opens a small box rather than firing at once.
  const [flagging, setFlagging] = useState(false); const [flagNote, setFlagNote] = useState("");
  const flag = useMutation({ mutationFn: () => api.post(`/api/flags/${id}`, { note: flagNote.trim() || null }), onSuccess: () => { setFlagging(false); setFlagNote(""); qc.invalidateQueries({ queryKey: ["item", id] }); } });
  const reviewed = useMutation({ mutationFn: () => api.post(`/api/admin/review/${id}/reviewed`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ["item", id] }) });
  const vote = useMutation({ mutationFn: (kind: "helpful_yes" | "helpful_no") => api.post("/api/signals", { itemId: id, kind }), onSuccess: () => qc.invalidateQueries({ queryKey: ["item", id] }) });
  useEffect(() => { window.scrollTo(0, 0); }, [id]);
  if (q.isLoading) return <div className="wf-page"><Loading /></div>;
  if (q.error) return <div className="wf-page"><ErrorState error={q.error} retry={() => q.refetch()} /></div>;
  const { item, placements, votes } = q.data!;
  const staff = me?.role === "staff";
  const primary = placements.find((p) => p.isPrimary) ?? placements[0];
  // Files already shown inside the body, and the video shown at the top, are not repeated below it.
  const rest = item.attachments.filter((a) => !item.bodyHtml.includes(`"${a.src}"`) && a.key !== item.primaryVideo?.key);
  const images = rest.filter((a) => a.kind === "image");
  const files = rest.filter((a) => a.kind !== "image");
  const kindLabel = item.isSeries || item.kind === "series" ? "Series" : item.kind === "question" || item.contentType === "question" ? "Q&A" : item.contentType ?? "Post";
  return (
    <div className="wf-page">
      {primary ? <Link to={`/map/${primary.key}`} className="wf-page-back">← {primary.jobName} · {primary.name}</Link> : <Link to="/map" className="wf-page-back">← Map</Link>}
      <div className="wf-page-header">
        <div>
          <div className="wf-record-tags" style={{ marginBottom: 8 }}><Pill item={item} /><RegionTags item={item} /><span className="wf-status wf-status-stage">{kindLabel}</span></div>
          <h1>{item.title}</h1>
          {/* Joined on whichever parts exist: the author of an item written here comes from a different field
              than a Connected author, and the separator used to key off the Connected one only. */}
          <p className="muted" style={{ marginTop: 6 }}>
            {[
              creditLine(item.native?.author?.name ?? item.authorName ?? null, item.steward),
              item.publishedAt ? `Published ${fmtDate(item.publishedAt)}` : null,
              item.updatedAt && item.updatedAt !== item.publishedAt ? `updated ${fmtDate(item.updatedAt)}` : null,
            ].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="wf-record-actions native-actions">
          {item.native && (item.native.kind === "google" || item.native.kind === "file") ? <a className="secondary-button" href={item.url} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Open in Google</a> : null}
          {item.native && me?.role === "staff" ? <Link className="secondary-button" to={`/admin/resources/${item.id}`}><Pencil size={16} /> Edit</Link> : null}
        </div>
      </div>
      {item.native?.status && item.native.status !== "published" ? <div className="wf-state wf-state-info" style={{ marginBottom: 16 }}><strong>{item.native.status === "pending" ? "Waiting for staff review" : "Not published"}</strong></div> : null}
      <div className="two-col">
        <div>
          <article className="wf-card wf-card-section">
            {item.primaryVideo ? <Media a={item.primaryVideo} /> : null}
            {item.description && item.description !== item.title ? <p className="lede" style={{ marginTop: 0 }}>{item.description}</p> : null}
            {item.bodyHtml ? <div className="wf-doc" dangerouslySetInnerHTML={{ __html: item.bodyHtml }} /> : null}
            {images.map((a) => <Media key={a.key} a={a} />)}
            {(item.isSeries || item.kind === "series" || item.native?.kind === "series") && item.contents.length ? <><h2 style={{ marginTop: 8 }}>In this series</h2><ItemGrid items={item.contents} context={{ from: "series" }} /></> : null}
            {!item.bodyHtml && !item.attachments.length && !item.linkedDocs.length && !item.contents.length ? <EmptyBody item={item} /> : null}
          </article>
          {files.length ? <section className="wf-card wf-card-section" style={{ marginTop: 16 }}><h2 style={{ marginTop: 0 }}>Files</h2>{files.map((a) => <Media key={a.key} a={a} />)}</section> : null}
          {item.linkedDocs.length ? <section className="wf-card wf-card-section" style={{ marginTop: 16 }}><h2 style={{ marginTop: 0 }}>Linked Google files</h2>
            {item.linkedDocs.map((d, i) => <figure className="wf-embed" key={i}><iframe src={embedUrl(d)} title={docLabel(d.kind)} loading="lazy" allowFullScreen /><figcaption><a href={d.url} target="_blank" rel="noreferrer">{docLabel(d.kind)} ↗</a>{d.status === "private" ? <span className="muted"> · shared privately; you may need to request access</span> : null}</figcaption></figure>)}
          </section> : null}
        </div>
        <aside>
          <div className="wf-card wf-card-section sticky">
            {item.summary ? <><h3 style={{ marginTop: 0 }}>At a glance</h3><p style={{ fontSize: ".92rem" }}><Linkify text={item.summary} /></p></> : null}
            <h3>Was this helpful?</h3>
            <div className="inline-actions"><button className={votes.mine === "helpful_yes" ? "primary-button" : ""} onClick={() => vote.mutate("helpful_yes")}><ThumbsUp size={16} /> Yes{votes.yes ? ` (${votes.yes})` : ""}</button><button className={votes.mine === "helpful_no" ? "primary-button" : ""} onClick={() => vote.mutate("helpful_no")}><ThumbsDown size={16} /> Not really{votes.no ? ` (${votes.no})` : ""}</button></div>
            <p className="muted" style={{ fontSize: ".8rem" }}>Votes feed the ranking so the best resources rise.</p>
            <h3 style={{ marginTop: 16 }}>Out of date or unclear?</h3>
            {item.flagged ? <p className="muted" style={{ fontSize: ".85rem" }}>You flagged this. Foundation staff will take a look.</p> : flagging ? (
              <div style={{ display: "grid", gap: 8 }}>
                <textarea rows={3} value={flagNote} onChange={(e) => setFlagNote(e.target.value)} placeholder="What looks wrong or out of date? (optional)" maxLength={1000} />
                <div className="inline-actions"><button className="primary-button small" disabled={flag.isPending} onClick={() => flag.mutate()}>Send to staff</button><button className="small" onClick={() => setFlagging(false)}>Cancel</button></div>
              </div>
            ) : <button className="small" onClick={() => setFlagging(true)}><Flag size={14} /> Flag for review</button>}
            {staff ? <>
              <h3 style={{ marginTop: 16 }}>Review</h3>
              <p className="muted" style={{ fontSize: ".85rem", marginBottom: 8 }}>{item.reviewedAt ? `Last reviewed ${fmtDate(item.reviewedAt)}${item.reviewedBy ? ` by ${item.reviewedBy.replace(/\s*<[^>]*>$/, "")}` : ""}` : "Never reviewed"}</p>
              <div className="inline-actions"><button className="small" disabled={reviewed.isPending} onClick={() => reviewed.mutate()}>Mark as reviewed today</button><Link className="small" to="/admin/queues/review">Review list</Link></div>
            </> : null}
            {item.seriesNav?.map((sn) => <div key={sn.seriesId} className="series-nav"><h3 style={{ marginTop: 16 }}>In this series: <Link to={`/item/${sn.seriesId}`}>{sn.seriesTitle}</Link></h3><ol>{sn.posts.map((p) => <li key={p.id} className={p.current ? "current" : ""} aria-current={p.current ? "page" : undefined}>{p.current ? <span>{p.title}</span> : <Link to={`/item/${p.id}`}>{p.title}</Link>}</li>)}</ol></div>)}
            <h3 style={{ marginTop: 16 }}>Where it lives on the map</h3>
            <ul className="wf-list tight" style={{ fontSize: ".875rem" }}>{placements.map((p) => <li key={p.key}><Link to={`/map/${p.key}`}>{p.jobName} › {p.name}</Link>{p.isPrimary ? <span className="muted"> (primary)</span> : null}</li>)}</ul>
            <h3 style={{ marginTop: 16 }}>Details</h3>
            <dl className="wf-record-facts">
              <div><dt>Views</dt><dd>{item.views.toLocaleString()}</dd></div>
              {item.categories.length ? <div><dt>Categories</dt><dd>{item.categories.join("; ")}</dd></div> : null}
              {item.audiences.length ? <div><dt>Audience tags</dt><dd>{item.audiences.join("; ")}</dd></div> : null}
            </dl>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Links inside imported content point at Connected ids; look the item up and go there. */
export function ConnectedRedirect() {
  const { kind, sourceId } = useParams(); const nav = useNavigate();
  const q = useQuery({ queryKey: ["by-source", kind, sourceId], queryFn: () => api.get<{ id: string; url: string }>(`/api/map/by-source/${kind}/${sourceId}`), retry: false });
  useEffect(() => { if (q.data) nav(`/item/${q.data.id}`, { replace: true }); }, [q.data, nav]);
  if (q.error) return <div className="wf-page narrow"><ErrorState error={q.error} /><p>That resource is not in Wildflower Wisdom. It may be unpublished or restricted in Connected.</p></div>;
  return <div className="wf-page"><Loading /></div>;
}
