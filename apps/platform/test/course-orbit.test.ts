import { describe, expect, it } from "vitest";
import { magnetIndex, projectCard, quadContains, viewBesidePanel, type OrbitCamera } from "../lib/course-orbit";

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

  it("hit-tests a projected card", () => {
    const { corners } = projectCard(0, camera(10));
    expect(quadContains(corners, 0, centreY(corners))).toBe(true);
    expect(quadContains(corners, 400, centreY(corners))).toBe(false);
    const mirrored = projectCard(Math.PI, camera(10)).corners;
    expect(quadContains(mirrored, 0, centreY(mirrored))).toBe(true);
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

  it("picks the nearest card once the ring has travelled further", () => {
    expect(magnetIndex(5.4, 3, 10)).toBe(5);
    expect(magnetIndex(5.6, 3, 10)).toBe(6);
  });

  it("never leaves the list", () => {
    expect(magnetIndex(-0.3, 0, 10)).toBe(0);
    expect(magnetIndex(9.3, 9, 10)).toBe(9);
    expect(magnetIndex(14, 9, 10)).toBe(9);
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
});
