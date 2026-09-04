"use client";

import { useEffect, useState } from "react";
import { PageTitle } from "../ui/PageTitle";
import { Overview } from "./Overview";
import { Partners } from "./Partners";
import { Engagements } from "./Engagements";
import { ChannelPolicy } from "./ChannelPolicy";

type Tab = "overview" | "partners" | "engagements" | "channel-policy";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Обзор" },
  { id: "partners", label: "Партнёры" },
  { id: "engagements", label: "Кампании" },
  { id: "channel-policy", label: "Политика каналов" },
];

/**
 * Agent Referrals operator console (Phase 9 round-2 fix, finding #3): a
 * compact surface inside the existing admin app - never a separate
 * interface - covering the independent blocker axes (partner onboarding
 * progression, engagement lifecycle), distribution facts intake/correction,
 * removal verification, and correction/recovery review the original Phase 9
 * plan requires an operator console for. Query-param driven (?tab=...&id=...)
 * exactly like the rest of this app's list/detail panels, since this is a
 * fully static export (no dynamic [id] routes).
 */
export function AgentReferrals() {
  const [tab, setTab] = useState<Tab>(() => (typeof window === "undefined" ? "overview" : (new URLSearchParams(window.location.search).get("tab") as Tab) || "overview"));
  const [selectedId, setSelectedId] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("id")));
  // Round-4 fix: a review-queue item names one specific distribution within its engagement, not merely
  // the engagement - focus carries that distribution_id through navigation so the destination screen can
  // highlight the exact flagged row, and focusReporting additionally asks it to auto-open that
  // distribution's reporting panel for the reporting-tail category.
  const [focusId, setFocusId] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("focus")));
  const [focusReporting, setFocusReporting] = useState(() => (typeof window === "undefined" ? false : new URLSearchParams(window.location.search).get("focusReporting") === "1"));

  useEffect(() => {
    const search = new URLSearchParams();
    search.set("tab", tab);
    if (selectedId) search.set("id", selectedId);
    if (focusId) search.set("focus", focusId);
    if (focusReporting) search.set("focusReporting", "1");
    window.history.replaceState(null, "", `/agent-referrals?${search.toString()}`);
  }, [tab, selectedId, focusId, focusReporting]);

  const changeTab = (next: Tab) => { setTab(next); setSelectedId(null); setFocusId(null); setFocusReporting(false); };
  // Overview's review-queue items link straight to the flagged record - the
  // Phase 9 round-3 fix for "an operator sees a count but nothing to act on".
  const navigate = (nextTab: "partners" | "engagements", id: string, focus?: string, reportingFocus?: boolean) => {
    setTab(nextTab); setSelectedId(id); setFocusId(focus ?? null); setFocusReporting(reportingFocus ?? false);
  };

  return (
    <>
      <PageTitle eyebrow="AGENT REFERRALS" title="Операторская консоль" text="Онбординг партнёров, кампании, размещения, вознаграждения и очередь проверки." />
      <nav className="tabs">
        {TABS.map((item) => (
          <button key={item.id} className={item.id === tab ? "nav-active" : ""} onClick={() => changeTab(item.id)}>{item.label}</button>
        ))}
      </nav>
      {tab === "overview" && <Overview onNavigate={navigate} />}
      {tab === "partners" && <Partners selected={selectedId} onSelect={setSelectedId} />}
      {tab === "engagements" && <Engagements selected={selectedId} onSelect={setSelectedId} focusDistributionId={focusId} focusReporting={focusReporting} />}
      {tab === "channel-policy" && <ChannelPolicy />}
    </>
  );
}
