import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ModalRouteController, { routeFromPath } from "./ModalRouteController";
import { toScheduleViewModel } from "@/lib/seo/schedule-view-model";
import { seoOccurrence } from "@/lib/seo/public-occurrence-fixture";

/**
 * The controller's history-state contract.
 *
 * WHAT A BROWSER PROVED AND CI CANNOT
 *
 * The behaviour this guards was verified empirically against the production
 * static export in Chrome on Next 16.3.0, because no headless DOM reproduces
 * Next's patched history or real session traversal:
 *
 *   home → /schedule → /events/<slug> → Back → Back → Forward → Forward
 *   all within ONE document (a page-load stamp never changed),
 *   with performance.getEntriesByType('navigation').length === 1
 *   and ZERO .txt or route requests.
 *   Closing from the event drawer ran go(-2), produced exactly ONE popstate at
 *   "/", and a subsequent Back landed on the page before home — never on a
 *   hidden /schedule entry.
 *
 * TWO FALSE ALARMS, recorded so they are not rediscovered:
 *
 *   1. An early go(-2) DID replace the document. Not a router fault: the probe
 *      had already run Back/Back/Forward/Forward, so it walked off the pushed
 *      entries into a genuine earlier navigation. From a clean sequence it
 *      restores correctly.
 *   2. /events/<slug> once rendered as a browser error page while the artifact
 *      was correct and the server returned 200 text/html. Browser-side, on that
 *      URL only; unrelated to routing. (A single-threaded local file server
 *      also stalls under a real page's ~38 parallel asset requests — use a
 *      threading one.)
 *
 * So do not "fix" this by assuming a pathname pushState triggers navigation.
 * It does not, on this version, and the tests below pin the parts that can be
 * checked without a browser.
 */
// DialogDrawer picks dialog vs drawer through useBreakpoint -> matchMedia,
// which jsdom does not implement. The breakpoint is irrelevant to the history
// contract under test, so a stable "desktop" answer is enough.
beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

const model = () => toScheduleViewModel([seoOccurrence()]);
const MARKER = "__fxModalRoute";

// Anchors live in a container this file owns and removes. Clearing
// document.body wholesale would destroy testing-library's own React container
// before its cleanup() could unmount, which surfaces as
// "NotFoundError: The node to be removed is not a child of this node".
let sandbox: HTMLElement;

const anchor = (href: string) => {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  a.textContent = href;
  sandbox.appendChild(a);
  return a;
};

const click = (el: HTMLElement, init: MouseEventInit = {}) => {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(ev);
  return ev;
};

describe("routeFromPath", () => {
  it("recognises only the two overlay routes", () => {
    expect(routeFromPath("/schedule")).toEqual({ kind: "schedule" });
    expect(routeFromPath("/events/saint-petersburg-abc")).toEqual({ kind: "event", slug: "saint-petersburg-abc" });
    expect(routeFromPath("/")).toEqual({ kind: "none" });
    expect(routeFromPath("/legal/public-offer")).toEqual({ kind: "none" });
    // Not a single event: a deeper path is somebody else's route.
    expect(routeFromPath("/events/a/b")).toEqual({ kind: "none" });
  });
});

describe("ModalRouteController history state", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    sandbox = document.createElement("div");
    document.body.appendChild(sandbox);
  });
  afterEach(() => { sandbox.remove(); });

  it("marks the root entry and pushes a namespaced marker for the overlay", () => {
    render(<ModalRouteController scheduleModel={model()} />);
    const ev = click(anchor("/schedule"));

    expect(ev.defaultPrevented).toBe(true);
    expect(window.location.pathname).toBe("/schedule");
    const marker = (window.history.state as Record<string, { depth: number; route: string; v: number }>)[MARKER];
    expect(marker.v).toBe(1);
    expect(marker.depth).toBe(1);
    expect(marker.route).toBe("schedule");
  });

  it("carries only our namespace into pushState, never a spread of the existing state", () => {
    // Next 16.3.0 patches pushState and SHORT-CIRCUITS on `data?.__NA`:
    //   if (data?.__NA || data?._N) return originalPushState(...)
    // Spreading the current history.state would carry __NA, so Next would treat
    // the call as one of its own and skip applyUrlFromHistoryPushReplace — the
    // address bar would move while the router's canonical URL did not.
    window.history.replaceState({ __NA: true, somethingElse: 1 }, "", "/");
    render(<ModalRouteController scheduleModel={model()} />);
    click(anchor("/schedule"));

    const state = window.history.state as Record<string, unknown>;
    expect(state[MARKER]).toBeDefined();
    // Nothing from the previous entry leaked across.
    expect(state.somethingElse).toBeUndefined();
  });

  it("deepens to 2 for an event opened from the schedule drawer", () => {
    render(<ModalRouteController scheduleModel={model()} />);
    click(anchor("/schedule"));
    click(anchor(`/events/${seoOccurrence().event_slug}`));

    const marker = (window.history.state as Record<string, { depth: number; route: string; eventSlug: string }>)[MARKER];
    expect(marker.depth).toBe(2);
    expect(marker.route).toBe("event");
    expect(marker.eventSlug).toBe(seoOccurrence().event_slug);
  });

  it.each([
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
    ["middle", { button: 1 }],
  ])("leaves a %s click as ordinary navigation", (_name, init) => {
    // This is what makes intercepting safe at all: open-in-new-tab, open-in-
    // new-window and a crawler all follow the href untouched.
    render(<ModalRouteController scheduleModel={model()} />);
    const ev = click(anchor("/schedule"), init);
    expect(ev.defaultPrevented).toBe(false);
    expect(window.location.pathname).toBe("/");
  });

  it.each([
    ["no marker at all", {}],
    ["wrong version", { [MARKER]: { v: 2, flowId: "f", depth: 1, route: "schedule" } }],
    ["empty flowId", { [MARKER]: { v: 1, flowId: "", depth: 1, route: "schedule" } }],
    ["depth out of range", { [MARKER]: { v: 1, flowId: "f", depth: 7, route: "schedule" } }],
    ["unknown route", { [MARKER]: { v: 1, flowId: "f", depth: 1, route: "checkout" } }],
    ["depth disagrees with route", { [MARKER]: { v: 1, flowId: "f", depth: 2, route: "schedule" } }],
    ["event without a slug", { [MARKER]: { v: 1, flowId: "f", depth: 2, route: "event" } }],
    ["event with an empty slug", { [MARKER]: { v: 1, flowId: "f", depth: 2, route: "event", eventSlug: "" } }],
  ])("re-roots the flow when the existing state is %s", (_name, state) => {
    // A valid marker authorises history.go(-depth), so anything short of fully
    // valid must not be treated as one. Each of these should be rejected and a
    // fresh root written, giving depth 1 for the first overlay — never a depth
    // inherited from a marker we could not verify.
    window.history.replaceState(state, "", "/");
    render(<ModalRouteController scheduleModel={model()} />);
    click(anchor("/schedule"));

    const marker = (window.history.state as Record<string, { depth: number; route: string }>)[MARKER];
    expect(marker.depth).toBe(1);
    expect(marker.route).toBe("schedule");
  });

  it("ignores links that are not overlay routes", () => {
    render(<ModalRouteController scheduleModel={model()} />);
    expect(click(anchor("/legal/public-offer")).defaultPrevented).toBe(false);
    expect(click(anchor("/")).defaultPrevented).toBe(false);
  });
});
