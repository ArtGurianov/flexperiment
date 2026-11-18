// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { motionValue } from "motion/react";
import { afterEach, expect, it, vi } from "vitest";
import { CircularGallery } from "../components/ui/circular-gallery";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("cross-fades named local WebP layers across exactly one card interval", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
  const position = motionValue(0);
  const { container } = render(
    <CircularGallery
      items={["basics", "bonebreaking", "brukup"]}
      position={position}
      zoom={motionValue(1)}
      offsetX={motionValue(0)}
      offsetY={motionValue(0)}
      onReady={() => {}}
    />,
  );
  const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-orbit-card]"));
  const opacity = () => cards.map((card) => Number(card.style.getPropertyValue("--course-main-opacity")));
  const [main, shadow] = cards[1].querySelectorAll("img");
  expect(main.getAttribute("src")).toBe("/course-covers/course-main-bonebreaking.webp");
  expect(shadow.getAttribute("src")).toBe("/course-covers/course-shadow-bonebreaking.webp");
  expect(main.style.opacity).toBe("var(--course-main-opacity, 0)");
  expect(shadow.style.opacity).toBe("calc(1 - var(--course-main-opacity, 0))");
  expect(opacity()).toEqual([1, 0, 0]);

  act(() => position.set(0.25));
  expect(opacity()).toEqual([0.75, 0.25, 0]);
  act(() => position.set(1));
  expect(opacity()).toEqual([0, 1, 0]);
  act(() => position.set(1.5));
  expect(opacity()).toEqual([0, 0.5, 0.5]);
  act(() => position.set(0.25));
  expect(opacity()).toEqual([0.75, 0.25, 0]);
});
