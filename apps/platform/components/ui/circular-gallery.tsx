"use client";

import { useEffect, useImperativeHandle, useRef, type HTMLAttributes, type Ref } from "react";
import type { MotionValue } from "motion/react";
import { clamp, projectCard, projectFloor, quadContains, type OrbitCamera, type ProjectedCard } from "@/lib/course-orbit";

// Circular 3D gallery, after "Circular Gallery" by Ravi Katiyar (21st.dev). The original lays DOM
// cards out with CSS 3D transforms and is seen head-on. This one draws the whole ring into a single
// Pixi.js canvas so that every card away from the front slot can be reduced to a flat dark
// silhouette, with correct overlap between cards, and the ring is seen from slightly above.

export interface GalleryItem {
  id: string;
  title: string;
  /** Short line above the title, e.g. level and lesson count. */
  caption?: string;
  /** Cover image URL. Must be same-origin or CORS-enabled: it is drawn into a WebGL texture. */
  image: string;
}

export interface CircularGalleryHandle {
  /** Index of the card under a viewport point, front-most first, or null. */
  pick: (clientX: number, clientY: number) => number | null;
}

/** The element must be given a size and a non-static position by the caller; the canvas fills it. */
interface CircularGalleryProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  items: GalleryItem[];
  /** Index of the card in the front slot; fractional while the ring turns. */
  position: MotionValue<number>;
  /** Scale of the whole ring, 1 at rest. */
  zoom: MotionValue<number>;
  /** Offset of the ring centre from the centre of the element, in CSS pixels. */
  offsetX: MotionValue<number>;
  offsetY: MotionValue<number>;
  /** Elevation of the viewpoint above the ring, in degrees. */
  tilt?: number;
  handle?: Ref<CircularGalleryHandle>;
  onReady?: () => void;
  /** Called instead of onReady when WebGL or Pixi cannot start. */
  onUnavailable?: () => void;
}

const CARD_WIDTH = 300;
const CARD_HEIGHT = 400;
const PERSPECTIVE = 1600;
const FACE_WIDTH = 720;
const FACE_HEIGHT = 960;
// Transparent margin baked into every texture so card edges are smoothed by texture filtering.
const FACE_MARGIN = 6;
const FACE_RADIUS = 14;
// A card is shown in colour while it is within this many cards of the front slot.
const REVEAL_WINDOW = 0.22;
const REVEAL_RATE = 9;
const FLOOR_SEGMENTS = 72;
const DISPLAY_FONT = '"Unbounded", sans-serif';
const TEXT_FONT = '"Manrope", sans-serif';

type Palette = { ink: number; paper: number; acid: number; inkCss: string; paperCss: string; acidCss: string };

const parseColor = (value: string, fallback: number) => {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  return match ? Number.parseInt(match[1], 16) : fallback;
};

const cssColor = (value: number) => `#${value.toString(16).padStart(6, "0")}`;

function readPalette(element: HTMLElement): Palette {
  const style = getComputedStyle(element);
  const ink = parseColor(style.getPropertyValue("--ink"), 0x171812);
  const paper = parseColor(style.getPropertyValue("--paper"), 0xf2eedf);
  const acid = parseColor(style.getPropertyValue("--acid"), 0xdfff00);
  return { ink, paper, acid, inkCss: cssColor(ink), paperCss: cssColor(paper), acidCss: cssColor(acid) };
}

const mixColor = (from: number, to: number, amount: number) => {
  const channel = (shift: number) => {
    const a = (from >> shift) & 0xff;
    const b = (to >> shift) & 0xff;
    return Math.round(a + (b - a) * amount) << shift;
  };
  return channel(16) | channel(8) | channel(0);
};

async function loadImage(src: string): Promise<HTMLImageElement | null> {
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = src;
    await image.decode();
    return image;
  } catch {
    return null;
  }
}

async function fontsReady(items: GalleryItem[]) {
  if (!("fonts" in document)) return;
  const sample = items.map((item) => `${item.title} ${item.caption ?? ""}`).join(" ");
  // Card text is painted once, so give the web fonts a moment, but never hold the carousel for them.
  await Promise.race([
    Promise.allSettled([
      document.fonts.load(`600 56px ${DISPLAY_FONT}`, `${sample} 0123456789`),
      document.fonts.load(`700 24px ${TEXT_FONT}`, sample),
    ]),
    new Promise((resolve) => setTimeout(resolve, 1200)),
  ]);
}

function faceCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = FACE_WIDTH + FACE_MARGIN * 2;
  canvas.height = FACE_HEIGHT + FACE_MARGIN * 2;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("CANVAS_2D_UNAVAILABLE");
  context.beginPath();
  context.roundRect(FACE_MARGIN, FACE_MARGIN, FACE_WIDTH, FACE_HEIGHT, FACE_RADIUS);
  context.clip();
  context.translate(FACE_MARGIN, FACE_MARGIN);
  return { canvas, context };
}

/** The card's outline, filled white, so one texture tinted per card draws every silhouette. */
function paintShape() {
  const { canvas, context } = faceCanvas();
  context.fillStyle = "#fff";
  context.fillRect(0, 0, FACE_WIDTH, FACE_HEIGHT);
  return canvas;
}

function wrapLines(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && context.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function paintFace(item: GalleryItem, index: number, image: HTMLImageElement | null, palette: Palette) {
  const { canvas, context } = faceCanvas();
  const inset = 44;
  context.fillStyle = palette.inkCss;
  context.fillRect(0, 0, FACE_WIDTH, FACE_HEIGHT);
  if (image && image.naturalWidth > 0) {
    const scale = Math.max(FACE_WIDTH / image.naturalWidth, FACE_HEIGHT / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.drawImage(image, (FACE_WIDTH - width) / 2, (FACE_HEIGHT - height) / 2, width, height);
  }
  const shade = context.createLinearGradient(0, FACE_HEIGHT * 0.42, 0, FACE_HEIGHT);
  shade.addColorStop(0, "rgba(10, 11, 8, 0)");
  shade.addColorStop(1, "rgba(10, 11, 8, 0.9)");
  context.fillStyle = shade;
  context.fillRect(0, 0, FACE_WIDTH, FACE_HEIGHT);

  context.textBaseline = "alphabetic";
  // Number tab in the corner.
  const number = String(index + 1).padStart(2, "0");
  context.font = `600 30px ${DISPLAY_FONT}`;
  const tabWidth = context.measureText(number).width + 36;
  context.fillStyle = palette.acidCss;
  context.fillRect(0, 0, tabWidth + 8, 76);
  context.fillStyle = palette.inkCss;
  context.fillText(number, 22, 50);

  // Title, bottom-aligned, with the caption above it.
  context.font = `600 56px ${DISPLAY_FONT}`;
  context.letterSpacing = "-2px";
  const lines = wrapLines(context, item.title, FACE_WIDTH - inset * 2).slice(0, 3);
  const lineHeight = 60;
  let baseline = FACE_HEIGHT - inset - (lines.length - 1) * lineHeight;
  context.fillStyle = palette.paperCss;
  if (item.caption) {
    context.font = `700 22px ${TEXT_FONT}`;
    context.letterSpacing = "2.5px";
    context.fillStyle = palette.acidCss;
    context.fillText(item.caption.toUpperCase(), inset, baseline - lineHeight - 4);
    context.font = `600 56px ${DISPLAY_FONT}`;
    context.letterSpacing = "-2px";
    context.fillStyle = palette.paperCss;
  }
  for (const line of lines) {
    context.fillText(line, inset, baseline);
    baseline += lineHeight;
  }
  return canvas;
}

export function CircularGallery({
  items, position, zoom, offsetX, offsetY, tilt = 10, handle, onReady, onUnavailable, className, style, ...props
}: CircularGalleryProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const pickRef = useRef<CircularGalleryHandle["pick"]>(() => null);
  const callbacks = useRef({ onReady, onUnavailable });

  useEffect(() => {
    callbacks.current = { onReady, onUnavailable };
  }, [onReady, onUnavailable]);

  useImperativeHandle(handle, () => ({ pick: (x, y) => pickRef.current(x, y) }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || items.length === 0) return;
    let disposed = false;
    let teardown = () => {};

    void (async () => {
      try {
        const palette = readPalette(host);
        const [pixi, images] = await Promise.all([
          import("pixi.js"),
          Promise.all(items.map((item) => loadImage(item.image))),
          fontsReady(items),
        ]);
        if (disposed) return;

        const app = new pixi.Application();
        await app.init({
          width: Math.max(host.clientWidth, 1),
          height: Math.max(host.clientHeight, 1),
          backgroundAlpha: 0,
          antialias: true,
          autoDensity: true,
          autoStart: false,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          preference: "webgl",
        });
        if (disposed) {
          app.destroy(true, true);
          return;
        }

        const texture = (canvas: HTMLCanvasElement) => new pixi.Texture({
          source: new pixi.CanvasSource({ resource: canvas, autoGenerateMipmaps: true, scaleMode: "linear", mipmapFilter: "linear" }),
        });
        const shapeTexture = texture(paintShape());
        const floor = new pixi.Graphics();
        const ring = new pixi.Container();
        ring.sortableChildren = true;
        ring.addChild(floor);
        floor.zIndex = -1e6;

        const cards = items.map((item, index) => {
          // Two layers per card: the dark outline, and the real face faded in over it at the front.
          const shadow = new pixi.PerspectiveMesh({ texture: shapeTexture, verticesX: 8, verticesY: 8 });
          const face = new pixi.PerspectiveMesh({ texture: texture(paintFace(item, index, images[index], palette)), verticesX: 12, verticesY: 12 });
          ring.addChild(shadow, face);
          const projected: ProjectedCard = { corners: [0, 0, 0, 0, 0, 0, 0, 0], depth: 0 };
          return { shadow, face, projected, reveal: 0 };
        });
        app.stage.addChild(ring);

        const canvas = app.canvas;
        canvas.style.position = "absolute";
        canvas.style.inset = "0";
        canvas.style.display = "block";
        // Pointer input belongs to the host element; without this Pixi's canvas would also block
        // touch scrolling of the page.
        canvas.style.pointerEvents = "none";
        canvas.setAttribute("aria-hidden", "true");
        host.appendChild(canvas);

        const faceScale = (FACE_WIDTH + FACE_MARGIN * 2) / FACE_WIDTH;
        const camera: OrbitCamera = {
          radius: 520,
          cardWidth: CARD_WIDTH * faceScale,
          cardHeight: CARD_HEIGHT * ((FACE_HEIGHT + FACE_MARGIN * 2) / FACE_HEIGHT),
          perspective: PERSPECTIVE,
          tilt: (tilt * Math.PI) / 180,
          lift: 0.55,
        };
        const step = (Math.PI * 2) / items.length;
        // Ring radius, in card widths, at which neighbouring cards would touch edge to edge.
        const touching = items.length > 2 ? 0.5 / Math.tan(Math.PI / items.length) : 0.75;
        const view = { width: 0, height: 0, unit: 1, x: 0, y: 0, scale: 1 };
        let layoutDirty = true;
        let visible = true;
        let last = { position: Number.NaN, zoom: Number.NaN, x: Number.NaN, y: Number.NaN };
        let announced = false;

        const layout = () => {
          const width = Math.max(host.clientWidth, 1);
          const height = Math.max(host.clientHeight, 1);
          if (width !== view.width || height !== view.height) app.renderer.resize(width, height);
          view.width = width;
          view.height = height;
          // The front card takes about half the stage height, less on narrow screens, and the ring
          // tightens on phones so the neighbouring silhouettes stay in view.
          const cardHeight = Math.min(height * 0.52, (width * 0.6) / (CARD_WIDTH / CARD_HEIGHT), 480);
          const cardWidth = cardHeight * (CARD_WIDTH / CARD_HEIGHT);
          view.unit = cardHeight / CARD_HEIGHT;
          camera.radius = clamp(width * 0.4, cardWidth * touching * 1.08, cardWidth * touching * 1.45) / view.unit;

          floor.clear();
          const points: number[] = [];
          for (let index = 0; index < FLOOR_SEGMENTS; index += 1) {
            const angle = (index / FLOOR_SEGMENTS) * Math.PI * 2;
            const [x, y] = projectFloor(Math.sin(angle) * camera.radius * 1.2, Math.cos(angle) * camera.radius * 1.2, camera);
            points.push(x, y);
          }
          floor.poly(points).fill({ color: palette.acid });
          layoutDirty = false;
        };

        const draw = (seconds: number) => {
          const front = position.get();
          const scale = zoom.get();
          const x = offsetX.get();
          const y = offsetY.get();
          const ease = 1 - Math.exp(-seconds * REVEAL_RATE);
          let animating = false;
          for (let index = 0; index < cards.length; index += 1) {
            const card = cards[index];
            const target = Math.abs(index - front) < REVEAL_WINDOW ? 1 : 0;
            if (card.reveal !== target) {
              const next = card.reveal + (target - card.reveal) * ease;
              card.reveal = Math.abs(target - next) < 0.004 ? target : next;
              animating = true;
            }
          }
          const moved = layoutDirty || front !== last.position || scale !== last.zoom || x !== last.x || y !== last.y;
          if (!moved && !animating) return;
          if (layoutDirty) layout();
          last = { position: front, zoom: scale, x, y };

          view.scale = view.unit * scale;
          view.x = view.width / 2 + x;
          view.y = view.height / 2 + y;
          ring.position.set(view.x, view.y);
          ring.scale.set(view.scale);

          const depthRange = 2 * camera.radius * Math.cos(camera.tilt);
          for (let index = 0; index < cards.length; index += 1) {
            const card = cards[index];
            const { corners, depth } = projectCard((index - front) * step, camera, card.projected);
            card.shadow.setCorners(...corners);
            // Silhouettes fade towards the page colour with distance, like figures in haze.
            card.shadow.tint = mixColor(palette.ink, palette.paper, clamp(-depth / depthRange, 0, 1) * 0.5);
            card.shadow.visible = card.reveal < 0.996;
            card.shadow.zIndex = depth;
            card.face.visible = card.reveal > 0.004;
            if (card.face.visible) {
              card.face.setCorners(...corners);
              card.face.alpha = card.reveal;
            }
            card.face.zIndex = depth + 0.5;
          }
          app.render();
          if (!announced) {
            announced = true;
            callbacks.current.onReady?.();
          }
        };

        pickRef.current = (clientX, clientY) => {
          const rect = host.getBoundingClientRect();
          const px = (clientX - rect.left - view.x) / view.scale;
          const py = (clientY - rect.top - view.y) / view.scale;
          let hit: number | null = null;
          let hitDepth = Number.NEGATIVE_INFINITY;
          cards.forEach((card, index) => {
            if (card.projected.depth > hitDepth && quadContains(card.projected.corners, px, py)) {
              hit = index;
              hitDepth = card.projected.depth;
            }
          });
          return hit;
        };

        const resizeObserver = new ResizeObserver(() => { layoutDirty = true; });
        resizeObserver.observe(host);
        const intersectionObserver = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
        intersectionObserver.observe(host);

        let frame = 0;
        let previous = performance.now();
        const tick = (now: number) => {
          frame = requestAnimationFrame(tick);
          const seconds = Math.min((now - previous) / 1000, 0.05);
          previous = now;
          // Nothing is drawn while the section is off screen or nothing has changed.
          if (visible) draw(seconds);
        };
        frame = requestAnimationFrame(tick);

        teardown = () => {
          cancelAnimationFrame(frame);
          resizeObserver.disconnect();
          intersectionObserver.disconnect();
          pickRef.current = () => null;
          app.destroy(true, { children: true, texture: true, textureSource: true });
        };
      } catch {
        if (!disposed) callbacks.current.onUnavailable?.();
      }
    })();

    return () => {
      disposed = true;
      teardown();
    };
  }, [items, position, zoom, offsetX, offsetY, tilt]);

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ overflow: "hidden", touchAction: "pan-y", ...style }}
      {...props}
    />
  );
}
