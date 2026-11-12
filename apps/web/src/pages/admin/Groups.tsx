import { NavLink, Outlet } from "react-router-dom";

/**
 * A group of staff pages that belong together: one entry in the sidebar, and a row of tabs across the
 * top to move between the pages inside it. Keeps the sidebar to the handful of things staff actually
 * pick between, rather than one line per page.
 */
export interface GroupTab { to: string; label: string }

export function SectionTabs({ tabs }: { tabs: GroupTab[] }) {
  return (
    <nav className="section-tabs" aria-label="Section">
      {tabs.map((t) => <NavLink key={t.to} to={t.to} end className={({ isActive }) => (isActive ? "active" : "")}>{t.label}</NavLink>)}
    </nav>
  );
}

/** Taxonomy and curation: the shape of the map, and what sits where on it. */
export const ORGANIZE_TABS: GroupTab[] = [
  { to: "/admin/organize/taxonomy", label: "Taxonomy" },
  { to: "/admin/organize/curation", label: "Curation" },
];

/** Everything waiting on a staff decision. */
export const QUEUE_TABS: GroupTab[] = [
  { to: "/admin/queues/contributions", label: "Contributions" },
  { to: "/admin/queues/retirement", label: "Retirement queue" },
  { to: "/admin/queues/review", label: "Review list" },
  { to: "/admin/queues/submissions", label: "Submission log" },
  { to: "/admin/queues/questions", label: "Questions" },
];

export function OrganizeLayout() { return <><SectionTabs tabs={ORGANIZE_TABS} /><Outlet /></>; }
export function QueuesLayout() { return <><SectionTabs tabs={QUEUE_TABS} /><Outlet /></>; }
