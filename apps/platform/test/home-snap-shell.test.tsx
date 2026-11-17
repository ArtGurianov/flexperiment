// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import HomeSnapShell from "../components/home/HomeSnapShell";

const router = vi.hoisted(() => ({
  path: "/basics",
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
      <section data-home-path="/basics" />
      <div hidden={!showBundle}><section data-home-path="/all-courses" /></div>
    </HomeSnapShell>
  );
}

beforeEach(() => {
  router.path = "/basics";
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
  expect(router.push).toHaveBeenLastCalledWith("/basics", { scroll: false });

  router.path = "/basics";
  rerender(sections(false));
  fireEvent.wheel(scroller, { deltaY: 40 });
  expect(router.push).toHaveBeenLastCalledWith("/all-courses", { scroll: false });
  expect(router.push).toHaveBeenCalledTimes(2);
});

it("routes a vertical touch swipe from the chapter to the bundle", () => {
  const { container } = render(sections(false));
  const chapter = container.querySelector('[data-home-path="/basics"]')!;
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

it("accepts the next strong upward notch after landing, without following the previous wheel momentum", () => {
  router.path = "/all-courses";
  const { container, rerender } = render(sections(true));
  const scroller = container.querySelector("main")!;
  fireEvent.wheel(scroller, { deltaY: -80 });
  expect(router.push).toHaveBeenCalledExactlyOnceWith("/basics", { scroll: false });

  router.path = "/basics";
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
      {loaded ? <section data-home-path="/basics" /> : null}
    </HomeSnapShell>
  );
  const { container, rerender } = render(layout(false));
  const carousel = container.querySelector<HTMLElement>("[data-home-path]")!;
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect(carousel.inert).not.toBe(true);

  rerender(layout(true));
  await vi.waitFor(() => expect(carousel.inert).toBe(true));
});

it("does not render an intercepted duplicate of a retained standalone course", () => {
  router.segments = { children: "basics", course: "(.)basics" };
  const { container } = render(
    <HomeSnapShell course={<section data-home-path="/basics" />}>
      <section data-home-path="/basics" />
    </HomeSnapShell>,
  );

  expect(container.querySelectorAll('[data-home-path="/basics"]')).toHaveLength(1);
});
