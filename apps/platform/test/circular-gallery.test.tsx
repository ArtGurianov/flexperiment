// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { motionValue } from "motion/react";
import { afterEach, expect, it, vi } from "vitest";
import { CircularGallery } from "../components/ui/circular-gallery";

const { init } = vi.hoisted(() => ({ init: vi.fn() }));

vi.mock("pixi.js", () => ({
  Application: class {
    init = init;
  },
}));

afterEach(cleanup);

it("uses the static fallback when WebGL is unavailable", async () => {
  init.mockRejectedValueOnce(new Error("No available renderer for the current environment"));
  const onReady = vi.fn();
  const onUnavailable = vi.fn();

  const { container } = render(
    <CircularGallery
      items={[{ id: "course", title: "Course", image: "/cover.svg" }]}
      position={motionValue(0)}
      zoom={motionValue(1)}
      offsetX={motionValue(0)}
      offsetY={motionValue(0)}
      onReady={onReady}
      onUnavailable={onUnavailable}
    />,
  );

  await waitFor(() => expect(onUnavailable).toHaveBeenCalledOnce());
  expect(init).toHaveBeenCalledWith(expect.objectContaining({ preference: ["webgl"] }));
  expect(onReady).not.toHaveBeenCalled();
  expect(container.querySelector("canvas")).toBeNull();
});
