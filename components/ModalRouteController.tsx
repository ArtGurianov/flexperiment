"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import DialogDrawer from "@/components/DialogDrawer";
import EventView from "@/components/EventView";
import ScheduleView from "@/components/ScheduleView";
import { useReconciledSchedule } from "@/hooks/useReconciledSchedule";
import { findEventInSchedule } from "@/lib/seo/event-view-model";
import type { ScheduleViewModel } from "@/lib/seo/schedule-view-model";

/**
 * Opens /schedule and /events/<slug> as drawers over the home document, while
 * the address bar, history and crawlers all see the real URLs.
 *
 * WHY THE HISTORY STATE LOOKS LIKE THIS
 *
 * Next 16 patches window.history.pushState. Reading the installed 16.3.0:
 *
 *     window.history.pushState = function pushState(data, _unused, url) {
 *       if (data?.__NA || data?._N) return originalPushState(...)   // ← !
 *       data = copyNextJsInternalHistoryState(data)
 *       if (url) applyUrlFromHistoryPushReplace(url)
 *       return originalPushState(data, _unused, url)
 *     }
 *
 * Two consequences, and both shape the code below:
 *
 *   1. NEVER spread the existing history.state into the new state. It contains
 *      __NA, which makes the patch treat our call as one of Next's own and skip
 *      applyUrlFromHistoryPushReplace — the URL would change while the router's
 *      canonical URL did not. We pass a fresh object carrying only our
 *      namespace, and copyNextJsInternalHistoryState adds Next's fields to it.
 *
 *   2. Because Next mutates the object we hand it, the marker has to be our own
 *      key rather than the whole state.
 *
 * WHY flowId AND NOT JUST depth
 *
 * Closing the event drawer has to return home in one step, which means
 * go(-depth). Trusting a bare depth is unsafe: if the entry was restored from a
 * previous session, belongs to a different flow, or the state was lost, go(-2)
 * could walk out of our own history and land somewhere arbitrary. The flowId
 * makes "this entry is one of mine, from this page load" checkable, and
 * anything else falls back to a plain navigation to "/".
 *
 * The drawer is closed by the resulting popstate, never eagerly — so URL,
 * history and UI all change from one source of events.
 */
const MARKER = "__fxModalRoute";

type ModalRouteKind = "home" | "schedule" | "event";

type ModalMarker = {
  readonly v: 1;
  readonly flowId: string;
  readonly depth: 0 | 1 | 2;
  readonly route: ModalRouteKind;
  readonly eventSlug?: string;
};

export type ModalRoute =
  | { readonly kind: "none" }
  | { readonly kind: "schedule" }
  | { readonly kind: "event"; readonly slug: string };

export const routeFromPath = (pathname: string): ModalRoute => {
  if (pathname === "/schedule") return { kind: "schedule" };
  const event = /^\/events\/([^/]+)$/.exec(pathname);
  return event ? { kind: "event", slug: event[1] } : { kind: "none" };
};

/**
 * Fully validates a history marker at runtime — every field, including the
 * relationships between them.
 *
 * A TypeScript cast proves nothing here. This value comes out of the browser's
 * history store: it can be restored from a previous session, written by an
 * older build of this page, or simply absent. Since a valid marker authorises
 * `history.go(-depth)`, a half-checked one would let a bad `depth` walk the
 * session out of our own entries into somewhere arbitrary.
 *
 * So depth and route are checked against their literal sets, and against each
 * other: the flow is home(0) → schedule(1) → event(2), and an event must name
 * the slug it is showing. Anything that does not satisfy all of it is not a
 * marker, and the caller takes the fail-safe path.
 */
const readMarker = (state: unknown): ModalMarker | null => {
  const raw = (state as Record<string, unknown> | null)?.[MARKER];
  if (typeof raw !== "object" || raw === null) return null;
  const { v, flowId, depth, route, eventSlug } = raw as Record<string, unknown>;

  if (v !== 1) return null;
  if (typeof flowId !== "string" || flowId.length === 0) return null;
  if (depth !== 0 && depth !== 1 && depth !== 2) return null;
  if (route !== "home" && route !== "schedule" && route !== "event") return null;

  // Depth and route are two views of one position; disagreeing means the entry
  // was not written by this contract.
  if (route === "home" && depth !== 0) return null;
  if (route === "schedule" && depth !== 1) return null;
  if (route === "event" && (depth !== 2 || typeof eventSlug !== "string" || eventSlug.length === 0)) {
    return null;
  }

  return { v: 1, flowId, depth, route, eventSlug: typeof eventSlug === "string" ? eventSlug : undefined };
};

/** Fresh object, our namespace only — see the note on __NA above. */
const markerState = (marker: ModalMarker) => ({ [MARKER]: marker });

/**
 * A click we may intercept: primary button, no modifier, same tab.
 *
 * Everything else stays an ordinary link — cmd/ctrl-click opens a tab,
 * middle-click opens a tab, shift-click opens a window, and a crawler follows
 * the href. That is what makes intercepting safe at all.
 */
const isPlainLeftClick = (event: MouseEvent): boolean =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey &&
  !event.defaultPrevented;

/**
 * Props are DATA, never render functions.
 *
 * A server component cannot hand a function to a client component — React
 * refuses it at build time ("Functions cannot be passed directly to Client
 * Components"). It is also the wrong shape: the drawer's first paint should
 * come from the same snapshot-derived model the standalone /schedule page is
 * built from, serialized into this page's payload, so opening the drawer costs
 * no round trip and shows the same content the canonical page would.
 *
 * The model is serialized props for a client island, not DOM content: no city
 * section or event anchor appears in the home page's body while the drawer is
 * closed. That boundary is asserted in the export tests.
 */
export default function ModalRouteController({
  scheduleModel,
}: {
  scheduleModel: ScheduleViewModel;
}) {
  const [route, setRoute] = useState<ModalRoute>({ kind: "none" });
  const flowId = useRef<string>("");

  useEffect(() => {
    if (!flowId.current) {
      flowId.current = `fx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    const open = (kind: "schedule" | "event", href: string, slug?: string) => {
      const current = readMarker(window.history.state);
      // Mark the entry we are standing on as this flow's root, once, so the
      // depth below is measured from a known place.
      if (!current || current.flowId !== flowId.current) {
        window.history.replaceState(
          markerState({ v: 1, flowId: flowId.current, depth: 0, route: "home" }),
          "",
          window.location.href,
        );
      }
      const base = readMarker(window.history.state);
      const depth = Math.min(2, (base?.depth ?? 0) + 1) as 1 | 2;
      window.history.pushState(
        markerState({ v: 1, flowId: flowId.current, depth, route: kind, eventSlug: slug }),
        "",
        href,
      );
      setRoute(kind === "schedule" ? { kind: "schedule" } : { kind: "event", slug: slug! });
    };

    const onClick = (event: MouseEvent) => {
      if (!isPlainLeftClick(event)) return;
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      const href = anchor.getAttribute("href") ?? "";
      const next = routeFromPath(href);
      if (next.kind === "none") return;
      event.preventDefault();
      open(next.kind, href, next.kind === "event" ? next.slug : undefined);
    };

    // The single source of truth for what is on screen. Prefer our marker; fall
    // back to the path so an entry whose state was dropped still resolves.
    const onPopState = (event: PopStateEvent) => {
      const marker = readMarker(event.state);
      if (marker && marker.flowId === flowId.current) {
        setRoute(
          marker.route === "schedule"
            ? { kind: "schedule" }
            : marker.route === "event" && marker.eventSlug
              ? { kind: "event", slug: marker.eventSlug }
              : { kind: "none" },
        );
        return;
      }
      setRoute(routeFromPath(window.location.pathname));
    };

    document.addEventListener("click", onClick);
    window.addEventListener("popstate", onPopState);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  /**
   * Closing returns to the home entry in one step, leaving no /schedule entry
   * behind for Back to land on. go(-depth) is only ever attempted for a valid
   * marker belonging to this flow; anything else is a plain navigation, which
   * is always correct if less elegant.
   */
  /**
   * Event drawer → schedule drawer, by moving history rather than by setting
   * local state. The popstate that results is what changes the URL and the UI
   * together; a setRoute here would leave the address bar on /events/<slug>
   * while the schedule was showing.
   */
  const back = useCallback(() => {
    const marker = readMarker(window.history.state);
    if (marker && marker.flowId === flowId.current && marker.route === "event") {
      window.history.back();
      return;
    }
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/");
  }, []);

  const close = useCallback(() => {
    const marker = readMarker(window.history.state);
    if (marker && marker.flowId === flowId.current && marker.depth > 0) {
      window.history.go(-marker.depth);
      return;
    }
    // Deliberately a HARD navigation, not router.push. This branch means the
    // history marker is missing, corrupt, or from another flow, so we stop
    // driving the modal router over state we no longer trust and get a fresh
    // home document and router state instead.
    //
    // Note what this does NOT do: it does not remove the unknown entries. They
    // stay in the session, and Back can still reach them. The guarantee is only
    // that we stop interpreting them.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/");
  }, []);

  // Lazy by design: a landing visitor who never opens the catalogue issues no
  // Commerce request at all. The read starts on first activation, and does not
  // run again while the flow stays open — schedule -> event -> schedule is one
  // flow, not three reasons to refetch. Closing re-arms it, because a visitor
  // who comes back to the schedule later has earned a fresh read.
  const modalActive = route.kind !== "none";
  const currentScheduleModel = useReconciledSchedule(scheduleModel, modalActive);

  // BOTH surfaces read the reconciled model, never the original prop. That is
  // what keeps the row a visitor clicked and the detail they land on agreeing
  // once a live read has moved a venue, date or price.
  const event = route.kind === "event" ? findEventInSchedule(currentScheduleModel, route.slug) : null;

  return (
    <div data-modal-route={route.kind} data-modal-slug={route.kind === "event" ? route.slug : ""}>
      {/* No local open state. History is the single authority: Escape, an
          outside click, a drag-down and the X all reach onClose, which moves
          history, and the resulting popstate is what sets `route` — which in
          turn closes this. One direction of flow, one source of truth. */}
      <DialogDrawer
        title={route.kind === "event" && event ? `${event.cityTitle}, ${event.dateLabel}` : "ГОРОДА × ДАТЫ"}
        isOpen={route.kind !== "none"}
        onClose={close}
        onBack={route.kind === "event" ? back : undefined}
      >
        <div data-testid="modal-drawer">
          {route.kind === "schedule" ? (
            <ScheduleView model={currentScheduleModel} />
          ) : (
            // Derived synchronously from the same reconciled model, so no
            // second data array rides in the home payload and no fetch precedes
            // first paint.
            event ? (
              <EventView event={event} headingLevel="h2" />
            ) : (
              // The slug is not in the published set. Only reachable if the URL
              // was hand-edited; the real page for a published slug is always a
              // static document, so hand over to it rather than inventing an
              // empty drawer.
              <p data-testid="modal-body">Открываем страницу события…</p>
            )
          )}
        </div>
      </DialogDrawer>
    </div>
  );
}
