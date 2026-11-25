// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import HomeSnapShell from "../components/home/HomeSnapShell";

const router = vi.hoisted(() => ({
  path: "/courses/basics",
  segments: {} as Record<string, string>,
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => router.path,
  useRouter: () => router,
  useSelectedLayoutSegment: (slot = "children") => router.segments[slot] ?? null,
}));

function sections(showBundle: boolean) {
  return (
    <HomeSnapShell>
      <section data-home-path="/" />
      <section data-home-path="/courses/basics" />
      <div hidden={!showBundle}><section data-home-path="/all-courses" /></div>
    </HomeSnapShell>
  );
}

function setupReturnScroll() {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const { container } = render(sections(false));
  const scroller = container.querySelector("main")!;
  const carousel = container.querySelector('[data-home-path="/"]')!;
  const scrollTo = vi.fn();
  Object.defineProperty(scroller, "scrollTo", { value: scrollTo });
  vi.spyOn(carousel, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, -scroller.scrollTop, 1440, 900));
  scroller.scrollTop = 900;
  return { scroller, scrollTo };
}

beforeEach(() => {
  router.path = "/courses/basics";
  router.segments = {};
  router.push.mockReset();
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.closest("[hidden]") ? 0 : 900;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("navigates from a committed course during the slide without a visible bundle panel", () => {
  const { container } = render(sections(false));
  const scroller = container.querySelector("main")!;
  const carousel = container.querySelector('[data-home-path="/"]')!;
  act(() => {
    fireEvent.wheel(carousel, { deltaY: 45 });
    fireEvent.wheel(scroller, { deltaY: 45 });
  });

  expect(router.push).toHaveBeenCalledExactlyOnceWith("/all-courses", { scroll: false });
});

it("routes back to the visible retained course and forward again without a native scroll event", () => {
  router.path = "/all-courses";
  const { container, rerender } = render(sections(true));
  const scroller = container.querySelector("main")!;
  fireEvent.wheel(scroller, { deltaY: -40 });
  expect(router.push).toHaveBeenLastCalledWith("/courses/basics", { scroll: false });

  router.path = "/courses/basics";
  rerender(sections(false));
  fireEvent.wheel(scroller, { deltaY: 40 });
  expect(router.push).toHaveBeenLastCalledWith("/all-courses", { scroll: false });
  expect(router.push).toHaveBeenCalledTimes(2);
});

it("routes a vertical touch swipe from the chapter to the bundle", () => {
  const { container } = render(sections(false));
  const chapter = container.querySelector('[data-home-path="/courses/basics"]')!;
  const start = { identifier: 1, clientX: 125, clientY: 600 };
  fireEvent.touchStart(chapter, { touches: [start] });
  fireEvent.touchEnd(chapter, { touches: [], changedTouches: [{ ...start, clientY: 350 }] });

  expect(router.push).toHaveBeenCalledExactlyOnceWith("/all-courses", { scroll: false });
});

it("returns from the course to the carousel on a small wheel notch", () => {
  const { container } = render(sections(false));
  fireEvent.wheel(container.querySelector("main")!, { deltaY: -10 });

  expect(router.push).toHaveBeenCalledExactlyOnceWith("/", { scroll: false });
});

it("keeps the course route mounted until the return scroll reaches the carousel", () => {
  const { scroller, scrollTo } = setupReturnScroll();

  fireEvent.wheel(scroller, { deltaY: -80 });
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: "smooth" });
  expect(router.push).not.toHaveBeenCalled();

  scroller.scrollTop = 450;
  fireEvent.scroll(scroller);
  fireEvent.wheel(scroller, { deltaY: -80 });
  expect(scrollTo).toHaveBeenCalledTimes(1);
  expect(router.push).not.toHaveBeenCalled();

  scroller.scrollTop = 0;
  fireEvent.scroll(scroller);
  expect(router.push).toHaveBeenCalledExactlyOnceWith("/", { scroll: false });
});

it("lands instantly and commits once if the browser has not completed the return scroll by the deadline", () => {
  vi.useFakeTimers();
  const { scroller, scrollTo } = setupReturnScroll();
  fireEvent.wheel(scroller, { deltaY: -80 });
  scroller.scrollTop = 12;
  fireEvent.scroll(scroller);

  act(() => { vi.advanceTimersByTime(1099); });
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: "smooth" });
  expect(router.push).not.toHaveBeenCalled();

  act(() => { vi.advanceTimersByTime(1); });
  expect(scrollTo).toHaveBeenNthCalledWith(2, { top: 0, behavior: "instant" });
  expect(router.push).toHaveBeenCalledExactlyOnceWith("/", { scroll: false });
  expect(scrollTo.mock.invocationCallOrder[1]).toBeLessThan(router.push.mock.invocationCallOrder[0]);

  scroller.scrollTop = 0;
  fireEvent.scroll(scroller);
  expect(router.push).toHaveBeenCalledTimes(1);
});

it("discards the deferred home navigation on popstate, even if the scroll later reaches the carousel", () => {
  vi.useFakeTimers();
  const { scroller, scrollTo } = setupReturnScroll();
  fireEvent.wheel(scroller, { deltaY: -80 });
  act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });

  scroller.scrollTop = 0;
  fireEvent.scroll(scroller);
  act(() => { vi.advanceTimersByTime(1100); });

  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: "smooth" });
  expect(router.push).not.toHaveBeenCalled();

  fireEvent.wheel(scroller, { deltaY: 80 });
  expect(router.push).toHaveBeenCalledExactlyOnceWith("/all-courses", { scroll: false });
});

it("accepts the next strong upward notch after landing, without following the previous wheel momentum", () => {
  router.path = "/all-courses";
  const { container, rerender } = render(sections(true));
  const scroller = container.querySelector("main")!;
  fireEvent.wheel(scroller, { deltaY: -80 });
  expect(router.push).toHaveBeenCalledExactlyOnceWith("/courses/basics", { scroll: false });

  router.path = "/courses/basics";
  rerender(sections(true));
  fireEvent.wheel(scroller, { deltaY: -8 });
  expect(router.push).toHaveBeenCalledTimes(1);
  fireEvent.wheel(scroller, { deltaY: -80 });
  expect(router.push).toHaveBeenLastCalledWith("/", { scroll: false });
  expect(router.push).toHaveBeenCalledTimes(2);
});

it("keeps the carousel interactive until the requested course panel arrives", async () => {
  const layout = (loaded: boolean) => (
    <HomeSnapShell>
      <section data-home-path="/" />
      {loaded ? <section data-home-path="/courses/basics" /> : null}
    </HomeSnapShell>
  );
  const { container, rerender } = render(layout(false));
  const carousel = container.querySelector<HTMLElement>("[data-home-path]")!;
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect(carousel.inert).not.toBe(true);

  rerender(layout(true));
  await vi.waitFor(() => expect(carousel.inert).toBe(true));
});

it("hides a retained intercepted course after returning to the homepage", () => {
  router.path = "/";
  const { container } = render(
    <HomeSnapShell course={<section data-home-path="/courses/basics" />}>
      <section data-home-path="/" />
    </HomeSnapShell>,
  );
  expect(container.querySelector('[data-home-path="/courses/basics"]')).toBeNull();
});

it("does not advance the route from the lesson panel", () => {
  router.path = "/courses/basics/lessons/intro";
  const { container } = render(<HomeSnapShell><section data-home-path={router.path} /></HomeSnapShell>);
  const panel = container.querySelector("section")!;
  fireEvent.wheel(panel, { deltaY: 200 });
  fireEvent.keyDown(panel, { key: "PageDown" });
  expect(router.push).not.toHaveBeenCalled();
});
