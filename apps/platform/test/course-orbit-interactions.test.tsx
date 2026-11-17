// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, type ComponentProps } from "react";
import type { MotionValue } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CourseOrbit from "../components/home/CourseOrbit";
import type { OrbitCourse } from "../components/home/orbit-course";
import type { CircularGallery } from "../components/ui/circular-gallery";

const timeline = vi.hoisted(() => ({
  ready: undefined as (() => void) | undefined,
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

// Keep MotionValues real and control when the carousel springs finish.
vi.mock("motion/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("motion/react")>(),
  useReducedMotion: () => false,
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
  slug, title: `${slug} course`, summary: `About the ${slug} course`, artwork: slug,
}));
const gallery = () => screen.getByRole("group", { name: /Курсы:/ });

function finishMotion() {
  act(() => {
    for (let batch = 0; batch < 2; batch += 1) {
      for (const complete of Array.from(timeline.animations)) complete();
    }
  });
}

function mount(visibleCourses = courses) {
  render(<CourseOrbit courses={visibleCourses} />);
  act(() => timeline.ready?.());
  finishMotion();
}

function wheel(deltaX: number, deltaY: number) {
  act(() => {
    expect(fireEvent.wheel(gallery(), { deltaX, deltaY })).toBe(false);
    vi.advanceTimersByTime(200);
  });
  finishMotion();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  timeline.animations.clear();
  timeline.ready = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("course carousel interactions", () => {
  it("reveals the details link only after the drawer finishes moving", () => {
    const { container } = render(<CourseOrbit courses={courses} />);
    const stage = container.querySelector<HTMLElement>("[data-home-path] > div")!;
    act(() => timeline.ready?.());

    expect(stage.style.getPropertyValue("--course-action-visibility")).toBe("hidden");
    finishMotion();
    expect(stage.style.getPropertyValue("--course-action-visibility")).toBe("visible");
  });

  it("wraps indefinitely in both wheel directions without scrolling the page", () => {
    mount();
    wheel(0, 1);
    expect(gallery()).toHaveAccessibleName(/1 из 3/);

    wheel(-40, 0);
    expect(gallery()).toHaveAccessibleName(/3 из 3/);
    wheel(0, 40);
    expect(gallery()).toHaveAccessibleName(/1 из 3/);

    for (let index = 0; index < 7; index += 1) wheel(0, 40);
    expect(gallery()).toHaveAccessibleName(/2 из 3/);
    for (let index = 0; index < 7; index += 1) wheel(0, -40);
    expect(gallery()).toHaveAccessibleName(/1 из 3/);
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("keeps the first drag when a second pointer arrives and settles after capture is lost", () => {
    mount();
    const arena = gallery();
    const primary = { pointerId: 1, pointerType: "touch", isPrimary: true };
    const secondary = { pointerId: 2, pointerType: "touch", isPrimary: false };
    Object.defineProperty(arena, "setPointerCapture", { value: vi.fn() });

    fireEvent.pointerDown(arena, { ...primary, clientX: 200 });
    fireEvent.pointerMove(arena, { ...primary, clientX: 155 });

    fireEvent.pointerDown(arena, { ...secondary, clientX: 400 });
    fireEvent.pointerMove(arena, { ...secondary, clientX: 200 });
    fireEvent.pointerUp(arena, { ...secondary, clientX: 200 });
    fireEvent.pointerMove(arena, { ...primary, clientX: 110 });

    fireEvent(arena, new PointerEvent("lostpointercapture", { ...primary, bubbles: true }));
    finishMotion();
    expect(arena.setPointerCapture).toHaveBeenCalledExactlyOnceWith(1);
    expect(gallery()).toHaveAccessibleName(/2 из 3/);
  });

  it("keeps the only course selected", () => {
    mount(courses.slice(0, 1));
    const card = screen.getByRole("group", { name: "first course" });
    fireEvent.keyDown(card, { key: "ArrowRight" });
    finishMotion();
    expect(card).toHaveAccessibleName("first course");
    expect(screen.queryByRole("button", { name: "Следующий курс" })).not.toBeInTheDocument();
  });

  it("uses the artwork name for the details route and wraps via arrow controls", () => {
    mount();
    expect(screen.getByRole("link", { name: "Подробнее" })).toHaveAttribute("href", "/first");

    fireEvent.click(screen.getByRole("button", { name: "Предыдущий курс" }));
    finishMotion();
    expect(screen.getByRole("link", { name: "Подробнее" })).toHaveAttribute("href", "/third");

    fireEvent.click(screen.getByRole("button", { name: "Следующий курс" }));
    finishMotion();
    expect(screen.getByRole("link", { name: "Подробнее" })).toHaveAttribute("href", "/first");
  });
});
