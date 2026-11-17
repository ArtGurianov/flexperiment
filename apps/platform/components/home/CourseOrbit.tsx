"use client";

import Link from "next/link";
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode,
} from "react";
import {
  animate, motion, useAnimationFrame, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform,
  type AnimationPlaybackControls,
} from "motion/react";
import { CircularGallery, type CircularGalleryHandle, type GalleryItem } from "@/components/ui/circular-gallery";
import { clamp, magnetIndex, RESTING_VIEW, viewBesidePanel, type OrbitView } from "@/lib/course-orbit";
import type { OrbitCourse } from "./dummy-courses";

// Home page course carousel. The section is taller than the viewport and its stage is pinned, so
// the page scroll position is the single source of truth for which card is in front: wheel, touch,
// dragging the ring, the arrow buttons and the magnet all work by moving the scroll position.
//
//   scrolling -> magnet pulls the nearest card to the front -> the card is revealed
//             -> the description sheet slides in and the ring zooms out to make room
//   scrolling again -> the sheet slides out and the ring zooms back in

// How long the scroll position has to stay still before the magnet engages.
const IDLE_MS = 130;
// How far (in cards) the ring may move off a settled card before the sheet closes.
const LEAVE_THRESHOLD = 0.04;
// How quickly the drawn ring catches up with the scroll position; evens out stepped wheel input.
const FOLLOW_RATE = 12;
const INTRO_TURN = 1.4;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const DESKTOP_QUERY = "(min-width: 1024px)";

type Engine = {
  /** Card index the scroll position points at, fractional. */
  target: number;
  /** Card the ring last settled on. */
  origin: number;
  /** Card the ring is being brought to, until it gets there. */
  arriving: number | null;
  magnet: AnimationPlaybackControls | null;
  /** Scroll position last written by the magnet, to tell its scroll events from the visitor's. */
  expected: number;
  intro: AnimationPlaybackControls | null;
  started: boolean;
  dragging: boolean;
  touching: boolean;
  /** The visitor has scrolled since the ring last settled. */
  moved: boolean;
  open: boolean;
  idle: number;
};

type DragState = { id: number; x: number; scroll: number; moved: boolean; lastX: number; lastTime: number; velocity: number };

const two = (value: number) => String(value).padStart(2, "0");

/** `children` is rendered at the top of the pinned stage; the home page passes its navigation bar. */
export default function CourseOrbit({ courses, children }: { courses: OrbitCourse[]; children?: ReactNode }) {
  const count = courses.length;
  const steps = Math.max(count - 1, 1);
  const reducedMotion = useReducedMotion() ?? false;

  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const arenaRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const gallery = useRef<CircularGalleryHandle>(null);
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const frontRef = useRef(0);
  const engine = useRef<Engine>({
    target: 0, origin: 0, arriving: null, magnet: null, expected: Number.NaN, intro: null,
    started: false, dragging: false, touching: false, moved: false, open: false, idle: 0,
  });

  // Card index in the front slot, as drawn; follows the scroll position with a little easing.
  const position = useMotionValue(0);
  // 0 with the description sheet away, 1 with it fully in. The sheet, the zoom and the re-centring
  // all read this one value, so they always move together.
  const openness = useMotionValue(0);
  const panelView = useMotionValue<OrbitView>(RESTING_VIEW);
  const zoom = useTransform(() => 1 + (panelView.get().scale - 1) * openness.get());
  const offsetX = useTransform(() => panelView.get().x * openness.get());
  const offsetY = useTransform(() => panelView.get().y * openness.get());

  const [active, setActive] = useState(0);
  const [front, setFront] = useState(0);
  const [open, setOpen] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const items = useMemo<GalleryItem[]>(() => courses.map((course) => ({
    id: course.slug, title: course.title, caption: `${course.level} · ${course.lessons} уроков`, image: course.image,
  })), [courses]);

  const show = useCallback((value: boolean) => {
    engine.current.open = value;
    setOpen(value);
  }, []);

  const metrics = useCallback(() => {
    const section = sectionRef.current;
    const stage = stageRef.current;
    if (!section || !stage) return null;
    const top = section.getBoundingClientRect().top + window.scrollY;
    const range = Math.max(section.offsetHeight - stage.offsetHeight, 1);
    return { top, range, step: range / steps };
  }, [steps]);

  const readTarget = useCallback(() => {
    const m = metrics();
    return m ? clamp((window.scrollY - m.top) / m.step, 0, steps) : 0;
  }, [metrics, steps]);

  const halt = useCallback(() => {
    const e = engine.current;
    e.magnet?.stop();
    e.magnet = null;
    e.intro?.stop();
    e.intro = null;
  }, []);

  /** Brings a card to the front by animating the page scroll to its snap point. */
  const snapTo = useCallback((index: number) => {
    const e = engine.current;
    const m = metrics();
    if (!m) return;
    const card = clamp(Math.round(index), 0, steps);
    const to = m.top + card * m.step;
    const from = window.scrollY;
    halt();
    e.arriving = card;
    if (Math.abs(to - from) < 1) return;
    if (reducedMotion) {
      e.expected = to;
      window.scrollTo(0, to);
      return;
    }
    e.expected = from;
    e.magnet = animate(from, to, {
      type: "spring", stiffness: 150, damping: 25, restDelta: 0.5, restSpeed: 4,
      onUpdate: (value) => {
        e.expected = value;
        window.scrollTo(0, value);
      },
      onComplete: () => { e.magnet = null; },
    });
  }, [halt, metrics, reducedMotion, steps]);

  const settleWhenIdle = useCallback(() => {
    const e = engine.current;
    window.clearTimeout(e.idle);
    e.idle = window.setTimeout(() => {
      if (e.dragging || e.touching || e.magnet || !e.moved) return;
      const m = metrics();
      // Outside the pinned range the page scrolls freely.
      if (!m || window.scrollY < m.top - 2 || window.scrollY > m.top + m.range + 2) return;
      snapTo(magnetIndex(readTarget(), e.origin, count));
    }, IDLE_MS);
  }, [count, metrics, readTarget, snapTo]);

  // Scroll, wheel, touch and keyboard: keep `target` current and decide when the magnet may act.
  useEffect(() => {
    const e = engine.current;
    e.target = readTarget();
    // Until the ring is ready it waits a part-turn away, so its first frames are the turn into place.
    if (!e.started) position.set(reducedMotion ? e.target : e.target - INTRO_TURN);

    const interrupt = () => {
      if (!e.magnet && !e.intro) return;
      halt();
      e.arriving = null;
      e.moved = true;
      settleWhenIdle();
    };
    const onScroll = () => {
      const y = window.scrollY;
      e.target = readTarget();
      if (e.open && Math.abs(e.target - e.origin) > LEAVE_THRESHOLD) show(false);
      const own = Math.abs(y - e.expected) < 2 || (e.magnet !== null && Math.abs(y - e.expected) < 90);
      if (own) return;
      halt();
      e.arriving = null;
      e.moved = true;
      settleWhenIdle();
    };
    const onTouchStart = () => {
      e.touching = true;
      interrupt();
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length > 0) return;
      e.touching = false;
      settleWhenIdle();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) interrupt();
    };
    const onResize = () => {
      // Snap points move with the viewport height; re-seat the ring on the nearest one.
      e.target = readTarget();
      if (!e.started || e.intro) return;
      e.moved = true;
      settleWhenIdle();
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", interrupt, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", interrupt);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
      window.clearTimeout(e.idle);
      halt();
    };
  }, [halt, position, readTarget, reducedMotion, settleWhenIdle, show]);

  // Once the ring can be drawn it turns into place, then settles on the card under the scroll position.
  const start = useCallback(() => {
    const e = engine.current;
    if (e.started) return;
    e.started = true;
    e.target = readTarget();
    if (reducedMotion) {
      position.set(e.target);
      snapTo(e.target);
      return;
    }
    e.intro = animate(position, e.target, {
      duration: 1.5, ease: [0.16, 1, 0.3, 1],
      onComplete: () => {
        e.intro = null;
        snapTo(e.target);
      },
    });
  }, [position, readTarget, reducedMotion, snapTo]);

  const onUnavailable = useCallback(() => {
    setUnavailable(true);
    start();
  }, [start]);

  useAnimationFrame((_, delta) => {
    const e = engine.current;
    if (!e.started || e.intro) return;
    const current = position.get();
    const gap = e.target - current;
    const next = reducedMotion || Math.abs(gap) < 0.0004
      ? e.target
      : current + gap * (1 - Math.exp((-Math.min(delta, 50) / 1000) * FOLLOW_RATE));
    if (next !== current) position.set(next);
    // The card has arrived: remember it, show its description.
    if (e.arriving !== null && !e.magnet && Math.abs(next - e.arriving) < 0.02 && Math.abs(e.target - e.arriving) < 0.01) {
      const card = e.arriving;
      e.origin = card;
      e.arriving = null;
      e.moved = false;
      setActive(card);
      show(true);
    }
  });

  useMotionValueEvent(position, "change", (value) => {
    const nearest = clamp(Math.round(value), 0, steps);
    if (nearest === frontRef.current) return;
    frontRef.current = nearest;
    setFront(nearest);
  });

  // The sheet's slide is plain CSS driven by --p on the stage.
  useMotionValueEvent(openness, "change", (value) => {
    stageRef.current?.style.setProperty("--p", value.toFixed(4));
  });

  useEffect(() => {
    const controls = animate(openness, open ? 1 : 0, reducedMotion
      ? { duration: 0.01 }
      : open ? { type: "spring", stiffness: 190, damping: 28 } : { type: "spring", stiffness: 300, damping: 35 });
    return () => controls.stop();
  }, [open, openness, reducedMotion]);

  // The zoom-out depends on how much of the stage the sheet actually covers, so measure both.
  useEffect(() => {
    const arena = arenaRef.current;
    const sheet = sheetRef.current;
    if (!arena || !sheet) return;
    const measure = () => {
      const side = window.matchMedia(DESKTOP_QUERY).matches ? "right" : "bottom";
      panelView.set(viewBesidePanel(
        { width: arena.clientWidth, height: arena.clientHeight },
        { width: sheet.offsetWidth, height: sheet.offsetHeight },
        side,
      ));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(arena);
    observer.observe(sheet);
    measure();
    return () => observer.disconnect();
  }, [panelView]);

  const go = (direction: number) => {
    const e = engine.current;
    snapTo((e.arriving ?? Math.round(e.target)) + direction);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    drag.current = {
      id: event.pointerId, x: event.clientX, scroll: window.scrollY, moved: false,
      lastX: event.clientX, lastTime: event.timeStamp, velocity: 0,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    const m = metrics();
    if (!state || state.id !== event.pointerId || !m) return;
    const dx = event.clientX - state.x;
    if (!state.moved) {
      if (Math.abs(dx) < 5) return;
      state.moved = true;
      engine.current.dragging = true;
      halt();
      engine.current.arriving = null;
      event.currentTarget.setPointerCapture(event.pointerId);
      setGrabbing(true);
    }
    // Pointer travel that turns the ring by one card.
    const perCard = clamp(event.currentTarget.clientWidth * 0.22, 150, 340);
    window.scrollTo(0, clamp(state.scroll - (dx / perCard) * m.step, m.top, m.top + m.range));
    const elapsed = event.timeStamp - state.lastTime;
    if (elapsed > 0) {
      const instant = -(event.clientX - state.lastX) / perCard / (elapsed / 1000);
      state.velocity = state.velocity * 0.3 + instant * 0.7;
      state.lastX = event.clientX;
      state.lastTime = event.timeStamp;
    }
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    drag.current = null;
    if (!state.moved) return;
    const e = engine.current;
    e.dragging = false;
    e.moved = true;
    setGrabbing(false);
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    if (cancelled) {
      // The browser took the gesture over as a page scroll; let the idle magnet finish it.
      settleWhenIdle();
      return;
    }
    // Release: carry a little of the throw, then let the magnet pick the card.
    const stale = event.timeStamp - state.lastTime > 80;
    const thrown = readTarget() + (stale ? 0 : clamp(state.velocity * 0.12, -1.2, 1.2));
    snapTo(magnetIndex(thrown, e.origin, count));
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (suppressClick.current) return;
    const index = gallery.current?.pick(event.clientX, event.clientY);
    if (index === null || index === undefined) return;
    // The front card opens its description; any other card comes to the front first.
    engine.current.moved = true;
    snapTo(index);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") go(1);
    else if (event.key === "ArrowLeft") go(-1);
    else if (event.key === "Enter") snapTo(Math.round(engine.current.target));
    else return;
    event.preventDefault();
  };

  const course = courses[active] ?? courses[0];
  const frontCourse = courses[front] ?? courses[0];
  if (!course) return null;

  return (
    <section
      ref={sectionRef}
      aria-labelledby="orbit-title"
      className="relative"
      style={{ height: `calc(100svh + ${steps} * clamp(260px, 44svh, 460px))` }}
    >
      <div ref={stageRef} className="sticky top-0 flex h-svh flex-col overflow-hidden bg-paper text-ink [--p:0]">
        {children}
        <div ref={arenaRef} className="relative min-h-0 flex-1">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(90deg,transparent_0_calc(25%-1px),var(--line)_calc(25%-1px)_25%)] opacity-45"
          />

          <CircularGallery
            handle={gallery}
            items={items}
            position={position}
            zoom={zoom}
            offsetX={offsetX}
            offsetY={offsetY}
            tilt={10}
            onReady={start}
            onUnavailable={onUnavailable}
            role="group"
            aria-roledescription="карусель"
            aria-label={`Курсы: ${frontCourse.title}, ${front + 1} из ${count}. Стрелки влево и вправо переключают курс.`}
            tabIndex={0}
            className={`absolute inset-0 select-none outline-none focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-ink ${grabbing ? "cursor-grabbing" : "cursor-grab"}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(event) => endDrag(event, false)}
            onPointerCancel={(event) => endDrag(event, true)}
            onClick={onClick}
            onKeyDown={onKeyDown}
          />

          {unavailable ? (
            <div
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2 aspect-[3/4] h-[52%] max-h-[480px] -translate-x-1/2 -translate-y-1/2 bg-ink bg-cover bg-center"
              style={{ backgroundImage: `url(${frontCourse.image})` }}
            />
          ) : null}

          <header className="pointer-events-none absolute left-[4vw] right-[4vw] top-[clamp(1rem,3.5vh,2.5rem)] z-10 opacity-[calc(1-var(--p))] lg:opacity-100">
            <p className="eyebrow m-0">Онлайн-школа флексинга · Новосибирск / весь мир</p>
            <h1
              id="orbit-title"
              className="m-0 mt-[clamp(.6rem,1.6vh,1.2rem)] font-display text-[clamp(1.7rem,4.3vw,4.2rem)] font-bold uppercase leading-[.9] tracking-[-.075em]"
            >
              Тело знает.<br />
              <em className="not-italic text-transparent [-webkit-text-stroke:1.5px_var(--ink)]">Дай ему язык.</em>
            </h1>
          </header>

          <div className="absolute bottom-[clamp(1rem,3.5vh,2.5rem)] left-[4vw] z-10 flex items-center gap-4">
            <p aria-hidden className="m-0 font-display text-[.8rem] font-semibold tracking-[.08em]">
              <span className="text-[1.6rem] tracking-[-.04em]">{two(front + 1)}</span> / {two(count)}
            </p>
            <div className="flex gap-2">
              {([[-1, "Предыдущий курс", "←"], [1, "Следующий курс", "→"]] as const).map(([direction, label, glyph]) => (
                <button
                  key={label}
                  type="button"
                  aria-label={label}
                  disabled={direction < 0 ? front <= 0 : front >= count - 1}
                  onClick={() => go(direction)}
                  className="grid size-11 cursor-pointer place-items-center border border-ink bg-transparent p-0 font-sans text-[1.1rem] text-ink transition-colors duration-200 hover:bg-ink hover:text-paper focus-visible:bg-ink focus-visible:text-paper disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink"
                >
                  <span aria-hidden>{glyph}</span>
                </button>
              ))}
            </div>
            <p className="m-0 hidden text-[.72rem] font-bold uppercase tracking-[.14em] text-muted sm:block">
              Листайте страницу или тяните карусель
            </p>
          </div>

          <aside
            ref={sheetRef}
            aria-label="Описание курса"
            aria-live="polite"
            inert={!open}
            className="absolute inset-x-0 bottom-0 z-20 translate-y-[calc((1-var(--p))*104%)] border-t-4 border-acid bg-ink text-paper will-change-transform lg:inset-x-auto lg:bottom-0 lg:right-0 lg:top-0 lg:w-[min(30rem,38vw)] lg:translate-x-[calc((1-var(--p))*104%)] lg:translate-y-0 lg:border-l-4 lg:border-t-0"
          >
            {/* Keyed by course: new copy rises in while the sheet is still sliding into place. */}
            <motion.div
              key={course.slug}
              initial={reducedMotion ? false : { opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
              className="flex flex-col p-5 lg:h-full lg:p-10"
            >
              <div className="flex items-center justify-between gap-4">
                <p className="m-0 font-display text-[.72rem] font-semibold uppercase tracking-[.08em] text-acid">
                  Курс {two(active + 1)} / {two(count)}
                </p>
                <button
                  type="button"
                  aria-label="Скрыть описание"
                  onClick={() => show(false)}
                  className="grid size-9 cursor-pointer place-items-center border border-paper/40 bg-transparent p-0 text-[1.1rem] leading-none text-paper transition-colors duration-200 hover:border-acid hover:bg-acid hover:text-ink focus-visible:border-acid focus-visible:bg-acid focus-visible:text-ink"
                >
                  <span aria-hidden>×</span>
                </button>
              </div>
              <h2 className="m-0 mt-4 font-display text-[clamp(1.5rem,2.6vw,2.5rem)] font-medium leading-none tracking-[-.05em] lg:mt-8">
                {course.title}
              </h2>
              <p className="m-0 mt-3 line-clamp-3 text-[.98rem] leading-[1.55] text-paper/80 lg:mt-5 lg:line-clamp-none lg:text-[1.05rem]">
                {course.summary}
              </p>
              <dl className="m-0 mt-4 grid grid-cols-3 gap-3 border-y border-paper/20 py-3 lg:mt-8 lg:py-5">
                {[["Уровень", course.level], ["Уроков", String(course.lessons)], ["Длительность", course.duration]].map(([term, value]) => (
                  <div key={term}>
                    <dt className="text-[.64rem] font-bold uppercase tracking-[.12em] text-paper/55">{term}</dt>
                    <dd className="m-0 mt-1 text-[.92rem] font-bold">{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="hidden lg:mt-8 lg:block">
                <p className="m-0 text-[.64rem] font-bold uppercase tracking-[.12em] text-paper/55">Внутри курса</p>
                <ol className="m-0 mt-3 list-none p-0">
                  {course.outline.map((line, index) => (
                    <li key={line} className="flex gap-4 border-b border-paper/15 py-3 text-[.98rem]">
                      <span className="font-display text-[.72rem] text-acid">{two(index + 1)}</span>
                      {line}
                    </li>
                  ))}
                </ol>
              </div>
              <Link
                href={course.href}
                className="mt-5 flex items-center justify-between gap-6 bg-acid px-5 py-4 text-[.95rem] font-bold uppercase text-ink! transition-[translate,background-color] duration-200 hover:-translate-x-1 hover:-translate-y-1 hover:bg-orange focus-visible:-translate-x-1 focus-visible:-translate-y-1 focus-visible:bg-orange lg:mt-auto"
              >
                Записаться на курс <span aria-hidden>↗</span>
              </Link>
            </motion.div>
          </aside>
        </div>
      </div>

      {/* The canvas is decorative to assistive technology and crawlers; this is the same list as text. */}
      <div className="sr-only">
        <h2>Курсы</h2>
        <ol>
          {courses.map((item) => (
            <li key={item.slug}>
              {item.title} — {item.level}, {item.lessons} уроков, {item.duration}. {item.summary}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
