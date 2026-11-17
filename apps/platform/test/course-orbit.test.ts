import { describe, expect, it } from "vitest";
import {
  magnetIndex,
  projectCard,
  projectFloor,
  quadContains,
  RESTING_VIEW,
  viewBesidePanel,
  type OrbitCamera,
} from "../lib/course-orbit";

const camera = (tilt: number): OrbitCamera => ({
  radius: 520, cardWidth: 300, cardHeight: 400, perspective: 1600, tilt: (tilt * Math.PI) / 180, lift: 0,
});
const centreY = (corners: number[]) => (corners[1] + corners[3] + corners[5] + corners[7]) / 4;
const width = (corners: number[], edge: "top" | "bottom") => (edge === "top" ? corners[2] - corners[0] : corners[4] - corners[6]);

describe("course carousel projection", () => {
  it("draws the front card at its natural size when seen head-on", () => {
    const { corners, depth } = projectCard(0, camera(0));
    expect(corners.map((value) => Math.round(value))).toEqual([-150, -200, 150, -200, 150, 200, -150, 200]);
    expect(depth).toBeCloseTo(0);
  });

  it("raises the far side of the ring when seen from 10 degrees above", () => {
    const flat = camera(0);
    const above = camera(10);
    expect(centreY(projectCard(Math.PI, flat).corners)).toBeCloseTo(centreY(projectCard(0, flat).corners));
    expect(centreY(projectCard(Math.PI, above).corners)).toBeLessThan(centreY(projectCard(0, above).corners) - 60);
    // Looking down on an upright card, its top edge is nearer and therefore wider.
    const front = projectCard(0, above).corners;
    expect(width(front, "top")).toBeGreaterThan(width(front, "bottom"));
  });

  it("orders cards by depth and shrinks them with distance", () => {
    const view = camera(10);
    const front = projectCard(0, view);
    const side = projectCard(Math.PI / 2, view);
    const back = projectCard(Math.PI, view);
    expect(front.depth).toBeGreaterThan(side.depth);
    expect(side.depth).toBeGreaterThan(back.depth);
    expect(width(back.corners, "top")).toBeLessThan(0); // facing away, so mirrored
    expect(Math.abs(width(back.corners, "top"))).toBeLessThan(width(front.corners, "top"));
  });

  it("projects a fully lifted front card around the origin with perspective at both edges", () => {
    const view = { ...camera(30), lift: 1 };
    const { corners, depth } = projectCard(0, view);
    // At 30 degrees of tilt, the top and bottom edges are 100 units nearer and farther.
    const topScale = 1600 / 1500;
    const bottomScale = 1600 / 1700;
    const halfHeight = 100 * Math.sqrt(3);

    expect(corners).toEqual([
      expect.closeTo(-150 * topScale), expect.closeTo(-halfHeight * topScale),
      expect.closeTo(150 * topScale), expect.closeTo(-halfHeight * topScale),
      expect.closeTo(150 * bottomScale), expect.closeTo(halfHeight * bottomScale),
      expect.closeTo(-150 * bottomScale), expect.closeTo(halfHeight * bottomScale),
    ]);
    expect(depth).toBe(0);
  });

  it("projects the floor through the bottom corners of the card at a quarter turn", () => {
    const view = { ...camera(10), lift: 0.55 };
    const { corners } = projectCard(Math.PI / 2, view);
    const halfWidth = view.cardWidth / 2;

    expect(projectFloor(view.radius, -halfWidth, view)).toEqual([
      expect.closeTo(corners[4]), expect.closeTo(corners[5]),
    ]);
    expect(projectFloor(view.radius, halfWidth, view)).toEqual([
      expect.closeTo(corners[6]), expect.closeTo(corners[7]),
    ]);
  });

  it("updates both depth and corners in a reused projection buffer", () => {
    const view = camera(10);
    const projected = projectCard(0, view);
    const { corners } = projected;

    expect(projectCard(Math.PI / 3, view, projected)).toBe(projected);
    expect(projected.corners).toBe(corners);
    expect(projected).toEqual(projectCard(Math.PI / 3, view));
  });

  it("hit-tests a projected card", () => {
    const { corners } = projectCard(0, camera(10));
    expect(quadContains(corners, 0, centreY(corners))).toBe(true);
    expect(quadContains(corners, 400, centreY(corners))).toBe(false);
    const mirrored = projectCard(Math.PI, camera(10)).corners;
    expect(quadContains(mirrored, 0, centreY(mirrored))).toBe(true);
  });

  it("rejects points on collapsed cards while accepting the edge of a visible card", () => {
    expect(quadContains([0, 0, 0, 0, 0, 0, 0, 0], 50, 50)).toBe(false);
    expect(quadContains([0, 0, 5, 5, 10, 10, 15, 15], 8, 8)).toBe(false);
    expect(quadContains([0, 0, 10, 0, 10, 10, 0, 10], 5, 0)).toBe(true);
  });
});

describe("course carousel magnet", () => {
  it("returns to the settled card after a negligible movement", () => {
    expect(magnetIndex(3.08, 3, 10)).toBe(3);
    expect(magnetIndex(2.95, 3, 10)).toBe(3);
  });

  it("advances one card on a deliberate movement short of halfway", () => {
    expect(magnetIndex(3.25, 3, 10)).toBe(4);
    expect(magnetIndex(2.7, 3, 10)).toBe(2);
  });

  it("requires movement strictly greater than the intent threshold in either direction", () => {
    expect(magnetIndex(3.25, 3, 10, 0.25)).toBe(3);
    expect(magnetIndex(2.75, 3, 10, 0.25)).toBe(3);
    expect(magnetIndex(3.26, 3, 10, 0.25)).toBe(4);
    expect(magnetIndex(2.74, 3, 10, 0.25)).toBe(2);
  });

  it("picks the nearest card once the ring has travelled further", () => {
    expect(magnetIndex(5.4, 3, 10)).toBe(5);
    expect(magnetIndex(5.6, 3, 10)).toBe(6);
  });

  it("follows travel direction at exactly half a card from the settled index", () => {
    expect(magnetIndex(2.5, 3, 10)).toBe(2);
    expect(magnetIndex(3.5, 3, 10)).toBe(4);
  });

  it("never leaves the list", () => {
    expect(magnetIndex(-0.3, 0, 10)).toBe(0);
    expect(magnetIndex(9.3, 9, 10)).toBe(9);
    expect(magnetIndex(14, 9, 10)).toBe(9);
  });

  it.each([0, 1])("returns index zero with %i available cards", (count) => {
    expect(magnetIndex(4.2, 0, count)).toBe(0);
  });
});

describe("course carousel zoom-out", () => {
  const stage = { width: 1440, height: 820 };

  it("shrinks to the share of the stage a side sheet leaves free and re-centres", () => {
    expect(viewBesidePanel(stage, { width: 480, height: 820 }, "right")).toEqual({ scale: 960 / 1440, x: -240, y: 0 });
  });

  it("keeps the zoom-out between 20% and 50%", () => {
    expect(viewBesidePanel(stage, { width: 120, height: 820 }, "right").scale).toBe(0.8);
    expect(viewBesidePanel(stage, { width: 1100, height: 820 }, "right").scale).toBe(0.5);
  });

  it("moves up, not sideways, for a bottom card", () => {
    expect(viewBesidePanel({ width: 390, height: 600 }, { width: 390, height: 240 }, "bottom")).toEqual({ scale: 0.6, x: 0, y: -120 });
  });

  it("applies both scale limits to a bottom panel while keeping its vertical offset", () => {
    expect(viewBesidePanel(stage, { width: 1000, height: 80 }, "bottom")).toEqual({ scale: 0.8, x: 0, y: -40 });
    expect(viewBesidePanel(stage, { width: 1000, height: 680 }, "bottom")).toEqual({ scale: 0.5, x: 0, y: -340 });
  });

  it.each([{ width: 0, height: 820 }, { width: 1440, height: 0 }])(
    "keeps the resting view before a $width by $height stage has been measured",
    (unmeasuredStage) => {
      const panel = { width: 480, height: 240 };
      expect(viewBesidePanel(unmeasuredStage, panel, "right")).toEqual(RESTING_VIEW);
      expect(viewBesidePanel(unmeasuredStage, panel, "bottom")).toEqual(RESTING_VIEW);
    },
  );
});
