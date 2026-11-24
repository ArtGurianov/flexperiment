"use client";

import { useCallback, useEffect, useEffectEvent, useRef, useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter, useSelectedLayoutSegment } from "next/navigation";
import { HomeLessonSelection, HomeSectionNavigation } from "./HomeSectionLink";

const BUNDLE_PATH = "/all-courses";
const WHEEL_IDLE_MS = 150;
const WHEEL_INTENT_PX = 6;
const WHEEL_RESTART_PX = 24;
const SWIPE_INTENT_PX = 48;
const RETURN_SCROLL_TIMEOUT_MS = 1100;

function isCoursePath(path: string) {
  return /^\/courses\/[^/]+$/.test(path);
}

function panelCanScroll(panel: HTMLElement, direction: number, top = panel.scrollTop) {
  return direction < 0 ? top > 1 : top + panel.clientHeight < panel.scrollHeight - 1;
}

export default function HomeSnapShell({ children, course, bundle }: {
  children: ReactNode;
  course?: ReactNode;
  bundle?: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const mainSegment = useSelectedLayoutSegment();
  const bundleSegment = useSelectedLayoutSegment("bundle")?.replace(/^\(\.\)/, "");
  const showBundleSlot = pathname === BUNDLE_PATH && mainSegment !== bundleSegment;
  const [selectedLesson, setSelectedLesson] = useState<string | null>(null);
  const [routing, startRouting] = useTransition();
  const root = useRef<HTMLElement>(null);
  const pending = useRef<string | null>(null);
  const cancelReturnScroll = useRef<(() => void) | null>(null);
  const previous = useRef(pathname);

  useEffect(() => {
    pending.current = null;
    return () => cancelReturnScroll.current?.();
  }, [pathname]);

  useEffect(() => {
    if (!routing && !cancelReturnScroll.current) pending.current = null;
  }, [routing]);

  useEffect(() => {
    const clearSelection = () => setSelectedLesson(null);
    window.addEventListener("popstate", clearSelection);
    return () => window.removeEventListener("popstate", clearSelection);
  }, []);

  const navigate = useCallback((path: string) => {
    if (path === pathname || (pending.current && pending.current !== pathname)) return false;
    pending.current = path;
    setSelectedLesson(/^\/courses\/[^/]+\/lessons\/[^/]+$/.test(path) ? path : null);
    const push = () => startRouting(() => router.push(path, { scroll: false }));
    const element = root.current;
    const carousel = path === "/" && element
      ? Array.from(element.querySelectorAll<HTMLElement>('[data-home-path="/"]')).find((panel) => panel.offsetHeight > 0)
      : undefined;

    if (!element || !carousel || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      push();
      return true;
    }

    const offset = carousel.getBoundingClientRect().top - element.getBoundingClientRect().top;
    if (Math.abs(offset) <= 1) {
      push();
      return true;
    }

    // The home URL clears the intercepted slots. Keep them mounted until the carousel is in view.
    const top = element.scrollTop + offset;
    const onScroll = () => {
      if (Math.abs(element.scrollTop - top) <= 1) finish();
    };
    const cancel = () => {
      element.removeEventListener("scroll", onScroll);
      window.clearTimeout(timeout);
      window.removeEventListener("popstate", cancel);
      cancelReturnScroll.current = null;
      if (pending.current === path) pending.current = null;
    };
    const finish = () => {
      if (cancelReturnScroll.current !== cancel) return;
      cancel();
      pending.current = path;
      push();
    };
    const timeout = window.setTimeout(() => {
      element.scrollTo({ top, behavior: "instant" });
      finish();
    }, RETURN_SCROLL_TIMEOUT_MS);
    cancelReturnScroll.current = cancel;
    element.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("popstate", cancel);
    element.scrollTo({ top, behavior: "smooth" });
    return true;
  }, [pathname, router]);

  const navigateFromGesture = useEffectEvent((direction: number) => {
    if (isCoursePath(pathname)) return navigate(direction > 0 ? BUNDLE_PATH : "/");
    if (pathname === BUNDLE_PATH && direction < 0) {
      const course = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-home-path]") ?? [])
        .find((panel) => panel.offsetHeight > 0 && isCoursePath(panel.dataset.homePath ?? ""));
      return navigate(course?.dataset.homePath ?? "/");
    }
    return false;
  });

  const routeForGesture = useEffectEvent(() => ({
    pathname,
    pending: pending.current !== null && pending.current !== pathname,
  }));

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const from = previous.current;
    const changed = from !== pathname;
    previous.current = pathname;

    const align = () => {
      const panels = Array.from(element.querySelectorAll<HTMLElement>("[data-home-path]"));
      const target = panels.find((panel) => panel.offsetHeight > 0 && panel.dataset.homePath === pathname);
      if (!target) return false;
      for (const panel of panels) panel.inert = panel !== target;
      if (changed) {
        const lessonLink = isCoursePath(pathname) && from.startsWith(pathname + "/lessons/")
          ? [...target.querySelectorAll<HTMLAnchorElement>("a[href]")]
            .find(link => link.getAttribute("href") === from && link.getClientRects().length > 0)
          : undefined;
        (lessonLink ?? target).focus({ preventScroll: true });
      }
      const offset = target.getBoundingClientRect().top - element.getBoundingClientRect().top;
      if (Math.abs(offset) > 1) {
        const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
        element.scrollTo({ top: element.scrollTop + offset, behavior: changed && !reduce ? "smooth" : "instant" });
      }
      return true;
    };

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!align()) return;
        observer.disconnect();
        resize.disconnect();
      });
    };
    // A restored Next.js slot may become visible without changing the DOM structure.
    const resize = new ResizeObserver(schedule);
    const observeTargets = () => {
      for (const panel of element.querySelectorAll<HTMLElement>("[data-home-path]")) {
        if (panel.dataset.homePath === pathname) resize.observe(panel);
      }
      schedule();
    };
    const observer = new MutationObserver(observeTargets);
    observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    observeTargets();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
    };
  }, [pathname]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let wheelAt = -Infinity;
    let wheelDirection = 0;
    let wheelDistance = 0;
    let wheelSnap: { path: string; pixels: number } | null = null;
    let touch: { id: number; x: number; y: number; path: string; panel: HTMLElement | null; top: number } | null = null;
    const panelAt = (event: Event, path: string) => {
      const panel = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-home-path]") : null;
      return panel?.dataset.homePath === path ? panel : null;
    };

    const onWheel = (event: WheelEvent) => {
      const { pathname: path, pending } = routeForGesture();
      if (event.ctrlKey) return;
      if (pending) {
        if (wheelSnap && Math.sign(event.deltaY) === wheelDirection) wheelAt = performance.now();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (path === "/" || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;

      const direction = Math.sign(event.deltaY);
      const panel = panelAt(event, path);
      if (panel && panelCanScroll(panel, direction)) return;
      event.preventDefault();
      event.stopPropagation();

      const pixels = Math.abs(event.deltaY) * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      const now = performance.now();
      if (direction !== wheelDirection || now - wheelAt > WHEEL_IDLE_MS) {
        wheelDistance = 0;
        wheelSnap = null;
      } else if (wheelSnap && path !== wheelSnap.path && pixels >= Math.max(WHEEL_RESTART_PX, wheelSnap.pixels)) {
        // A new strong notch can advance once the previous snap has landed. Its weaker
        // momentum events still belong to the previous gesture.
        const active = panel ?? Array.from(element.querySelectorAll<HTMLElement>("[data-home-path]"))
          .find((candidate) => candidate.offsetHeight > 0 && candidate.dataset.homePath === path);
        if (active && Math.abs(active.getBoundingClientRect().top - element.getBoundingClientRect().top) < 3) {
          wheelDistance = 0;
          wheelSnap = null;
        }
      }
      wheelAt = now;
      wheelDirection = direction;
      if (wheelSnap) return;
      wheelDistance += pixels;
      if (wheelDistance >= WHEEL_INTENT_PX && navigateFromGesture(direction)) wheelSnap = { path, pixels };
    };

    const onTouchStart = (event: TouchEvent) => {
      const { pathname: path, pending } = routeForGesture();
      if (path === "/" || pending || event.touches.length !== 1) {
        touch = null;
        return;
      }
      const [point] = event.touches;
      const panel = panelAt(event, path);
      touch = { id: point.identifier, x: point.clientX, y: point.clientY, path, panel, top: panel?.scrollTop ?? 0 };
    };
    const onTouchEnd = (event: TouchEvent) => {
      const start = touch;
      touch = null;
      if (!start || start.path !== routeForGesture().pathname || event.touches.length) return;
      const point = Array.from(event.changedTouches).find(({ identifier }) => identifier === start.id);
      if (!point) return;
      const dy = start.y - point.clientY;
      if (Math.abs(dy) < SWIPE_INTENT_PX || Math.abs(dy) <= Math.abs(point.clientX - start.x)) return;
      const direction = Math.sign(dy);
      if (!start.panel || !panelCanScroll(start.panel, direction, start.top)) navigateFromGesture(direction);
    };
    const onTouchCancel = () => { touch = null; };

    const onKey = (event: KeyboardEvent) => {
      const { pathname: path, pending } = routeForGesture();
      if (path === "/" || pending || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      const direction = event.key === " " && !target?.closest("a, button")
        ? event.shiftKey ? -1 : 1
        : { ArrowUp: -1, PageUp: -1, ArrowDown: 1, PageDown: 1 }[event.key];
      if (!direction) return;
      const panel = panelAt(event, path);
      if (panel && panelCanScroll(panel, direction)) return;
      if (!navigateFromGesture(direction)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    element.addEventListener("wheel", onWheel, { capture: true, passive: false });
    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchend", onTouchEnd, { passive: true });
    element.addEventListener("touchcancel", onTouchCancel, { passive: true });
    element.addEventListener("keydown", onKey, true);
    return () => {
      element.removeEventListener("wheel", onWheel, true);
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchend", onTouchEnd);
      element.removeEventListener("touchcancel", onTouchCancel);
      element.removeEventListener("keydown", onKey, true);
    };
  }, []);

  return (
    <HomeSectionNavigation.Provider value={navigate}>
      <main ref={root} className="homeSnap fixed inset-0 z-0 h-dvh snap-y snap-mandatory overflow-hidden overscroll-contain bg-paper">
        <HomeLessonSelection.Provider value={selectedLesson}>
          {children}
          {pathname === "/" ? null : course}
          {showBundleSlot ? bundle : null}
        </HomeLessonSelection.Provider>
      </main>
    </HomeSectionNavigation.Provider>
  );
}
