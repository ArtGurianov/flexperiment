// Pure geometry and interaction maths for the home page course carousel.

export const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export type OrbitCamera = {
  /** Distance from the ring axis to each card centre, in world units. */
  radius: number;
  cardWidth: number;
  cardHeight: number;
  /** Distance from the viewer to the front card; larger is flatter. */
  perspective: number;
  /** How far above the ring the viewer sits, in radians. 0 is the original front view. */
  tilt: number;
  /** 0 keeps the ring axis on the origin, 1 keeps the front card centre on it. */
  lift: number;
};

export type ProjectedCard = {
  /** Screen-space corners, clockwise from top-left: x0, y0, x1, y1, x2, y2, x3, y3. */
  corners: [number, number, number, number, number, number, number, number];
  /** Depth of the card centre: 0 at the front slot, negative behind it. */
  depth: number;
};

const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;

/**
 * Projects one card of the ring onto the screen. `angle` is the card's position on the ring, 0 being
 * the front slot. The ring is seen from `tilt` above the horizon, so cards at the back rise on screen
 * and the top edge of every card leans towards the viewer.
 */
export function projectCard(angle: number, camera: OrbitCamera, out?: ProjectedCard): ProjectedCard {
  const { radius, perspective, tilt, lift } = camera;
  const halfWidth = camera.cardWidth / 2;
  const halfHeight = camera.cardHeight / 2;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const sinTilt = Math.sin(tilt);
  const cosTilt = Math.cos(tilt);
  const result = out ?? { corners: [0, 0, 0, 0, 0, 0, 0, 0], depth: 0 };

  for (let index = 0; index < 4; index += 1) {
    const [sx, sy] = CORNERS[index];
    // Ring space: x right, y down, z towards the viewer; the card faces outwards.
    const x = radius * sin + sx * halfWidth * cos;
    const y = sy * halfHeight;
    const z = radius * cos - sx * halfWidth * sin;
    // Look down on the ring, then slide it back so the front slot sits at depth 0.
    const tiltedY = y * cosTilt + z * sinTilt - lift * radius * sinTilt;
    const tiltedZ = z * cosTilt - y * sinTilt - radius * cosTilt;
    const scale = perspective / (perspective - tiltedZ);
    result.corners[index * 2] = x * scale;
    result.corners[index * 2 + 1] = tiltedY * scale;
  }
  result.depth = radius * cos * cosTilt - radius * cosTilt;
  return result;
}

/** Projects a point of the floor the cards stand on, for drawing the stage disc under the ring. */
export function projectFloor(x: number, z: number, camera: OrbitCamera): [number, number] {
  const { radius, perspective, tilt, lift } = camera;
  const sinTilt = Math.sin(tilt);
  const cosTilt = Math.cos(tilt);
  const y = camera.cardHeight / 2;
  const tiltedY = y * cosTilt + z * sinTilt - lift * radius * sinTilt;
  const tiltedZ = z * cosTilt - y * sinTilt - radius * cosTilt;
  const scale = perspective / (perspective - tiltedZ);
  return [x * scale, tiltedY * scale];
}

/** Cross-fades the main face over the single card interval on either side of the front slot. */
export function orbitIndex(index: number, count: number): number {
  return count > 0 ? ((index % count) + count) % count : 0;
}

export function orbitDistance(index: number, position: number, count: number): number {
  return count > 1 ? orbitIndex(index - position + count / 2, count) - count / 2 : 0;
}

export function cardFaceOpacity(index: number, position: number, count: number): number {
  return clamp(1 - Math.abs(orbitDistance(index, position, count)), 0, 1);
}

/** Maps a rectangular DOM card onto the four corners of its projected plane. */
export function quadTransform(
  [x0, y0, x1, y1, x2, y2, x3, y3]: ProjectedCard["corners"],
  width: number,
  height: number,
): string | null {
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const determinant = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(determinant) < 1e-8) return null;

  // CSS divides by the homogeneous coordinate after applying the matrix.
  const dx = x0 - x1 + x2 - x3;
  const dy = y0 - y1 + y2 - y3;
  const g = (dx * dy2 - dy * dx2) / determinant;
  const h = (dx1 * dy - dy1 * dx) / determinant;
  return `matrix3d(${[
    (x1 - x0 + g * x1) / width, (y1 - y0 + g * y1) / width, 0, g / width,
    (x3 - x0 + h * x3) / height, (y3 - y0 + h * y3) / height, 0, h / height,
    0, 0, 1, 0,
    x0, y0, 0, 1,
  ].join(",")})`;
}

/**
 * Picks the card the carousel should come to rest on. Past the halfway point the nearest card wins;
 * short of it, a movement larger than `intent` still advances one card in the direction of travel,
 * so a single wheel notch or a short drag is not pulled back to where it started.
 */
export function magnetIndex(position: number, origin: number, intent = 0.14): number {
  const delta = position - origin;
  const distance = Math.abs(delta);
  if (distance <= intent || distance > 0.5) return Math.round(position);
  return delta > 0 ? Math.floor(origin) + 1 : Math.ceil(origin) - 1;
}

export type OrbitView = { scale: number; x: number; y: number };

export const RESTING_VIEW: OrbitView = { scale: 1, x: 0, y: 0 };

/**
 * How the carousel makes room for the description panel: it shrinks to the share of the stage the
 * panel leaves free, held between 20% and 50% smaller, and re-centres in what is left.
 */
export function viewBesidePanel(
  stage: { width: number; height: number },
  panel: { width: number; height: number },
  side: "right" | "bottom",
): OrbitView {
  if (stage.width <= 0 || stage.height <= 0) return RESTING_VIEW;
  const free = side === "right" ? (stage.width - panel.width) / stage.width : (stage.height - panel.height) / stage.height;
  return {
    scale: clamp(free, 0.5, 0.8),
    x: side === "right" ? -panel.width / 2 : 0,
    y: side === "bottom" ? -panel.height / 2 : 0,
  };
}
