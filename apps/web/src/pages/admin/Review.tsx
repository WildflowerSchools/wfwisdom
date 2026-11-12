import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDate } from "../../api";
import { ErrorState, Loading, State } from "../../components/ui";

type Row = { id: string; title: string; type: string; author: string | null; steward: string | null; stewardId: string | null; updatedAt: string | null; reviewedAt: string | null; reviewedBy: string | null; hidden: boolean; dated: string | null; place: string | null; flags: number; flagNote: string | null; mine: boolean };
type Person = { id: string; name: string; email: string };
const age = (iso: string | null) => { if (!iso) return null; const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000); return d < 1 ? "today" : d < 60 ? `${d} days ago` : d < 730 ? `${Math.round(d / 30.4)} months ago` : `${(d / 365).toFixed(1)} years ago`; };

/** The whole library, longest unreviewed first. Nothing is scheduled: staff work the list when they choose to. */
export function AdminReview() {
  const qc = useQueryClient(); const [mine, setMine] = useState(false); const [flagged, setFlagged] = useState(false); const [shown, setShown] = useState(100);
  const q = useQuery({ queryKey: ["review-list"], queryFn: () => api.get<{ items: Row[]; people: Person[]; me: string }>("/api/admin/review") });
  const done = () => qc.invalidateQueries({ queryKey: ["review-list"] });
  const reviewed = useMutation({ mutationFn: (id: string) => api.post(`/api/admin/review/${id}/reviewed`, {}), onSuccess: done });
  const steward = useMutation({ mutationFn: ({ id, userId }: { id: string; userId: string | null }) => api.post(`/api/admin/review/${id}/steward`, { userId }), onSuccess: done });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const all = q.data!.items; const rows = all.filter((r) => (!mine || r.mine) && (!flagged || r.flags > 0));
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <State kind="info" title="Review list">Every published resource, the longest unreviewed first. Open one, fix what needs fixing, then mark it reviewed. Where the author has left Wildflower, choose a steward: the page then reads “Originally created by … ; stewarded by …”. A reader’s flag stays on a resource until it is marked reviewed.</State>
      <div className="inline-actions">
        <div className="segmented"><button className={!mine ? "active" : ""} onClick={() => setMine(false)}>All resources ({all.length})</button><button className={mine ? "active" : ""} onClick={() => setMine(true)}>Mine ({all.filter((r) => r.mine).length})</button></div>
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: ".85rem" }}><input type="checkbox" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} /> Flagged only ({all.filter((r) => r.flags > 0).length})</label>
      </div>
      {rows.length === 0 ? <State kind="empty" title="Nothing here" /> :
        <div className="table-wrap"><table className="wf-table"><thead><tr><th>Resource</th><th>Author</th><th>Steward</th><th>Updated</th><th>Last reviewed</th><th></th></tr></thead><tbody>
          {rows.slice(0, shown).map((r) => <tr key={r.id}>
            <td style={{ maxWidth: 380 }}><Link to={`/item/${r.id}`}>{r.title}</Link>{r.flags ? <> <span className="wf-status wf-status-attention" title={r.flagNote ?? undefined}>Flagged{r.flags > 1 ? ` ×${r.flags}` : ""}</span></> : null}{r.hidden ? <> <span className="wf-status">Hidden</span></> : null}
              {r.flagNote ? <div className="muted" style={{ fontSize: ".78rem" }}>“{r.flagNote}”</div> : null}{r.place ? <div className="muted" style={{ fontSize: ".78rem" }}>{r.place}</div> : null}</td>
            <td>{r.author ?? <span className="muted">—</span>}</td>
            <td><select value={r.stewardId ?? ""} disabled={steward.isPending} onChange={(e) => steward.mutate({ id: r.id, userId: e.target.value || null })} aria-label={`Steward for ${r.title}`}><option value="">None</option>{q.data!.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></td>
            <td>{r.updatedAt ? fmtDate(r.updatedAt) : "—"}</td>
            <td>{r.reviewedAt ? <><span title={fmtDate(r.reviewedAt)}>{age(r.reviewedAt)}</span><div className="muted" style={{ fontSize: ".78rem" }}>{r.reviewedBy?.replace(/\s*<[^>]*>$/, "")}</div></> : <span className="wf-status wf-status-attention">Never</span>}</td>
            <td><button className="small" disabled={reviewed.isPending} onClick={() => reviewed.mutate(r.id)}>Mark reviewed</button></td>
          </tr>)}
        </tbody></table></div>}
      {rows.length > shown ? <button onClick={() => setShown(shown + 200)}>Show more ({rows.length - shown} left)</button> : null}
    </div>
  );
}
