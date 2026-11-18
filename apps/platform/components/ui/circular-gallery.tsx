"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, type HTMLAttributes } from "react";
import { useMotionValueEvent, type MotionValue } from "motion/react";
import { cardFaceOpacity, clamp, orbitDistance, projectCard, projectFloor, quadTransform, type OrbitCamera } from "@/lib/course-orbit";

interface CircularGalleryProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  items: string[];
  position: MotionValue<number>;
  zoom: MotionValue<number>;
  offsetX: MotionValue<number>;
  offsetY: MotionValue<number>;
  onReady: () => void;
}

const CARD_WIDTH = 300;
const CARD_HEIGHT = 400;
const TILT = Math.PI / 18;
const FLOOR_SEGMENTS = 72;

export function CircularGallery({
  items, position, zoom, offsetX, offsetY, onReady, style, ...props
}: CircularGalleryProps) {
  const host = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const floor = useRef<HTMLDivElement>(null);
  const cards = useRef<Array<HTMLDivElement | null>>([]);
  const unit = useRef(1);
  const camera = useRef<OrbitCamera>({
    radius: 520, cardWidth: CARD_WIDTH, cardHeight: CARD_HEIGHT, perspective: 1600, tilt: TILT, lift: 0.55,
  });

  const draw = useCallback(() => {
    if (!ring.current) return;
    const front = position.get();
    ring.current.style.transform = `translate(${offsetX.get()}px, ${offsetY.get()}px) scale(${unit.current * zoom.get()})`;

    items.forEach((_, index) => {
      const card = cards.current[index];
      if (!card) return;
      const angle = orbitDistance(index, front, items.length) * (2 * Math.PI / items.length);
      const { corners, depth } = projectCard(angle, camera.current);
      const transform = quadTransform(corners, CARD_WIDTH, CARD_HEIGHT);
      card.style.visibility = transform ? "" : "hidden";
      if (transform) card.style.transform = transform;
      card.style.zIndex = String(Math.round(depth * 1000));
      card.style.setProperty("--course-main-opacity", String(cardFaceOpacity(index, front, items.length)));
    });
  }, [items, offsetX, offsetY, position, zoom]);

  useMotionValueEvent(position, "change", draw);
  useMotionValueEvent(zoom, "change", draw);
  useMotionValueEvent(offsetX, "change", draw);
  useMotionValueEvent(offsetY, "change", draw);

  useEffect(() => {
    const element = host.current;
    const disc = floor.current;
    if (!element || !disc) return;

    const layout = () => {
      const { clientWidth: width, clientHeight: height } = element;
      if (width === 0 || height === 0) return;
      const cardHeight = Math.min(height * 0.52, width * 0.8, 480);
      const touching = items.length > 2 ? 0.5 / Math.tan(Math.PI / items.length) : 0.75;
      const cardWidth = cardHeight * CARD_WIDTH / CARD_HEIGHT;
      unit.current = cardHeight / CARD_HEIGHT;
      const view = camera.current;
      view.radius = clamp(width * 0.4, cardWidth * touching * 1.08, cardWidth * touching * 1.45) / unit.current;
      const floorRadius = view.radius * 1.2;
      const points = Array.from({ length: FLOOR_SEGMENTS }, (_, index) => {
        const angle = index * 2 * Math.PI / FLOOR_SEGMENTS;
        return projectFloor(Math.sin(angle) * floorRadius, Math.cos(angle) * floorRadius, view);
      });
      const xs = points.map(([x]) => x);
      const ys = points.map(([, y]) => y);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      disc.style.left = `${left}px`;
      disc.style.top = `${top}px`;
      disc.style.width = `${Math.max(...xs) - left}px`;
      disc.style.height = `${Math.max(...ys) - top}px`;
      disc.style.clipPath = `polygon(${points.map(([x, y]) => `${x - left}px ${y - top}px`).join(",")})`;
      draw();
    };

    layout();
    const observer = new ResizeObserver(layout);
    observer.observe(element);
    const frame = requestAnimationFrame(onReady);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [draw, items.length, onReady]);

  return (
    <div ref={host} style={{ overflow: "hidden", touchAction: "pan-y", ...style }} {...props}>
      <div ref={ring} aria-hidden className="absolute top-1/2 left-1/2 isolate">
        <div ref={floor} className="pointer-events-none absolute z-[-2000000] bg-acid" />
        {items.map((id, index) => (
          <div
            key={id}
            ref={(element) => { cards.current[index] = element; }}
            data-orbit-card={index}
            className="absolute top-0 left-0 isolate origin-top-left overflow-hidden rounded-md"
            style={{ width: CARD_WIDTH, height: CARD_HEIGHT, visibility: "hidden" }}
          >
            <Image
              src={`/course-covers/course-main-${id}.webp`}
              alt="" fill unoptimized loading="eager" draggable={false}
              className="pointer-events-none object-contain"
              style={{ opacity: "var(--course-main-opacity, 0)" }}
            />
            <Image
              src={`/course-covers/course-shadow-${id}.webp`}
              alt="" fill unoptimized loading="eager" draggable={false}
              className="pointer-events-none object-contain"
              style={{ opacity: "calc(1 - var(--course-main-opacity, 0))", mixBlendMode: "plus-lighter" }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
