// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, type ComponentProps } from "react";
import type { MotionValue } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CourseOrbit from "../components/home/CourseOrbit";
import type { OrbitCourse } from "../components/home/orbit-course";
import type { CircularGallery } from "../components/ui/circular-gallery";

type Frame = (time: number, delta: number) => void;
const timeline = vi.hoisted(() => ({
  ready: undefined as (() => void) | undefined,
  frame: undefined as Frame | undefined,
  animations: new Set<() => void>(),
}));

vi.mock("../components/ui/circular-gallery", () => ({
  CircularGallery: ({
    onReady, role, "aria-label": label, onKeyDown, onPointerDown, onPointerMove,
    onPointerUp, onPointerCancel, onLostPointerCapture,
  }: ComponentProps<typeof CircularGallery>) => {
    useEffect(() => {
      timeline.ready = onReady;
    }, [onReady]);
    return (
      <div
        role={role}
        aria-label={label}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onLostPointerCapture}
      />
    );
  },
}));

// Keep MotionValues real and control when the carousel's intro and scroll springs finish.
vi.mock("motion/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("motion/react")>(),
  useReducedMotion: () => false,
  useAnimationFrame: (frame: Frame) => { timeline.frame = frame; },
  animate: (
    from: number | MotionValue<number>,
    to: number,
    options: { onUpdate?: (value: number) => void; onComplete?: () => void },
  ) => {
    const complete = () => {
      timeline.animations.delete(complete);
      if (typeof from === "number") options.onUpdate?.(to);
      else from.set(to);
      options.onComplete?.();
    };
    timeline.animations.add(complete);
    return { stop: () => timeline.animations.delete(complete) };
  },
}));

const courses: OrbitCourse[] = ["first", "second", "third"].map((slug) => ({
  slug, title: `${slug} course`, summary: `About the ${slug} course`, href: `/courses/${slug}`, artwork: slug,
}));
const sectionTop = 100;
const stageHeight = 800;
const cardStep = 300;

let scrollY: number;
let sectionHeight: number;

const gallery = () => screen.getByRole("group", { name: /Курсы:/ });

function scrollPage(y: number) {
  scrollY = y;
  window.dispatchEvent(new Event("scroll"));
}

function finishMotion() {
  act(() => {
    // The intro may start a separate snap animation when it completes.
    for (let batch = 0; batch < 2; batch += 1) {
      for (const complete of Array.from(timeline.animations)) complete();
    }
    for (let frame = 1; frame <= 24; frame += 1) timeline.frame?.(frame * 50, 50);
  });
}

function mount(y = sectionTop, visibleCourses = courses) {
  scrollY = y;
  sectionHeight = stageHeight + cardStep * (visibleCourses.length - 1);
  const result = render(<CourseOrbit courses={visibleCourses} />);
  act(() => timeline.ready?.());
  finishMotion();
  return result;
}

function waitForMagnet() {
  act(() => vi.advanceTimersByTime(200));
  finishMotion();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => scrollY);
  vi.stubGlobal("scrollTo", vi.fn((left: number | ScrollToOptions, top?: number) => {
    scrollPage(typeof left === "number" ? top ?? scrollY : left.top ?? scrollY);
  }));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.tagName === "SECTION" ? sectionHeight : stageHeight;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.tagName === "SECTION" ? new DOMRect(0, sectionTop - scrollY, 800, sectionHeight) : new DOMRect();
  });
});

afterEach(() => {
  cleanup();
  timeline.animations.clear();
  timeline.ready = undefined;
  timeline.frame = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("course carousel interactions", () => {
  it("leaves a restored scroll position below the pinned section in place when the gallery becomes ready", () => {
    const restoredPosition = sectionTop + cardStep * 3;
    mount(restoredPosition);

    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(window.scrollY).toBe(restoredPosition);
  });

  it("advances once for a burst of small wheel events and can advance again after settling", () => {
    mount();
    const wheel = (deltaY: number) => act(() => {
      if (fireEvent.wheel(gallery(), { deltaY })) scrollPage(scrollY + deltaY);
    });

    wheel(1);
    waitForMagnet();
    expect(gallery()).toHaveAccessibleName(/1 из 3/);

    wheel(12);
    wheel(12);
    waitForMagnet();
    expect(window.scrollY).toBe(sectionTop + cardStep);
    expect(gallery()).toHaveAccessibleName(/2 из 3/);

    wheel(12);
    waitForMagnet();
    expect(window.scrollY).toBe(sectionTop + cardStep * 2);
    expect(gallery()).toHaveAccessibleName(/3 из 3/);
  });

  it("keeps the first drag when a second pointer arrives and settles after capture is lost", () => {
    mount();
    const arena = gallery();
    const primary = { pointerId: 1, pointerType: "touch", isPrimary: true };
    const secondary = { pointerId: 2, pointerType: "touch", isPrimary: false };
    Object.defineProperty(arena, "setPointerCapture", { value: vi.fn() });

    fireEvent.pointerDown(arena, { ...primary, clientX: 200 });
    fireEvent.pointerMove(arena, { ...primary, clientX: 155 });
    const firstPosition = scrollY;
    expect(firstPosition).toBeGreaterThan(sectionTop);

    fireEvent.pointerDown(arena, { ...secondary, clientX: 400 });
    fireEvent.pointerMove(arena, { ...secondary, clientX: 200 });
    fireEvent.pointerUp(arena, { ...secondary, clientX: 200 });
    expect(scrollY).toBe(firstPosition);
    fireEvent.pointerMove(arena, { ...primary, clientX: 140 });
    expect(scrollY).toBeGreaterThan(firstPosition);

    fireEvent(arena, new PointerEvent("lostpointercapture", { ...primary, bubbles: true }));
    waitForMagnet();
    expect(window.scrollY).toBe(sectionTop + cardStep);
    expect(gallery()).toHaveAccessibleName(/2 из 3/);
  });

  it("keeps the only course selected and leaves page scroll alone on next-card navigation", () => {
    mount(sectionTop, courses.slice(0, 1));
    const card = screen.getByRole("group", { name: "first course" });

    fireEvent.keyDown(card, { key: "ArrowRight" });
    finishMotion();

    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(card).toHaveAccessibleName("first course");
    expect(screen.queryByRole("button", { name: "Предыдущий курс" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Следующий курс" })).not.toBeInTheDocument();
  });

  it("opens the corresponding course link after arrow navigation", () => {
    mount();
    expect(screen.getByRole("link", { name: "Открыть курс" })).toHaveAttribute("href", "/courses/first");

    fireEvent.click(screen.getByRole("button", { name: "Следующий курс" }));
    finishMotion();

    expect(screen.getByRole("link", { name: "Открыть курс" })).toHaveAttribute("href", "/courses/second");
  });
});
