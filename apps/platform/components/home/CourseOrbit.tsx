"use client";

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode,
} from "react";
import {
  animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform,
  type AnimationPlaybackControls,
} from "motion/react";
import { CircularGallery } from "@/components/ui/circular-gallery";
import { clamp, magnetIndex, orbitDistance, orbitIndex, RESTING_VIEW, viewBesidePanel, type OrbitView } from "@/lib/course-orbit";
import HomeSectionLink from "./HomeSectionLink";
import type { OrbitCourse } from "./orbit-course";

const IDLE_MS = 130;
const WHEEL_PIXELS_PER_CARD = 300;
const DESKTOP_QUERY = "(min-width: 1024px)";

type DragState = {
  id: number;
  x: number;
  y: number;
  position: number;
  axis: "x" | "y" | null;
  lastPosition: number;
  lastTime: number;
  velocity: number;
};

const two = (value: number) => String(value).padStart(2, "0");

export default function CourseOrbit({ courses, children }: { courses: OrbitCourse[]; children?: ReactNode }) {
  const count = courses.length;
  const canNavigate = count > 1;
  const reducedMotion = useReducedMotion() ?? false;
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const arenaRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const frontRef = useRef(0);
  const engine = useRef({
    destination: null as number | null,
    animation: null as AnimationPlaybackControls | null,
    wheel: null as { origin: number; direction: number } | null,
    idle: 0,
    started: false,
  });
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

  const items = useMemo(() => courses.map((course) => course.coverPath), [courses]);

  const stop = useCallback(() => {
    const state = engine.current;
    window.clearTimeout(state.idle);
    state.animation?.stop();
    state.animation = null;
    state.destination = null;
    state.wheel = null;
  }, []);

  const snapTo = useCallback((target: number) => {
    stop();
    const state = engine.current;
    const destination = Math.round(target);
    state.destination = destination;
    const settle = () => {
      const index = orbitIndex(destination, count);
      state.destination = null;
      state.animation = null;
      position.set(index);
      setActive(index);
      setOpen(true);
    };
    if (reducedMotion || Math.abs(destination - position.get()) < 0.001) {
      settle();
      return;
    }
    setOpen(false);
    state.animation = animate(position, destination, { type: "spring", stiffness: 250, damping: 32, onComplete: settle });
  }, [count, position, reducedMotion, stop]);

  const start = useCallback(() => {
    if (engine.current.started) return;
    engine.current.started = true;
    snapTo(position.get());
  }, [position, snapTo]);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const vertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
      const delta = vertical ? event.deltaY : event.deltaX;
      if (!delta) return;

      const sheet = sheetRef.current;
      if (vertical && sheet && event.target instanceof Node && sheet.contains(event.target)) {
        const canScroll = delta < 0
          ? sheet.scrollTop > 0
          : sheet.scrollTop + sheet.clientHeight < sheet.scrollHeight - 1;
        if (canScroll) return;
      }

      event.preventDefault();
      if (!canNavigate || drag.current?.axis) return;
      const current = position.get();
      const direction = Math.sign(delta);
      const state = engine.current;
      const origin = state.wheel?.direction === direction ? state.wheel.origin : current;
      stop();
      state.wheel = { origin, direction };
      const pixels = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? section.clientHeight : 1);
      const target = current + clamp(pixels / WHEEL_PIXELS_PER_CARD, -2, 2);
      position.set(target);
      if (Math.abs(target - origin) > 0.04) setOpen(false);
      state.idle = window.setTimeout(() => {
        snapTo(magnetIndex(position.get(), origin, 2 / WHEEL_PIXELS_PER_CARD));
      }, IDLE_MS);
    };
    section.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      section.removeEventListener("wheel", onWheel);
      stop();
    };
  }, [canNavigate, position, snapTo, stop]);

  useMotionValueEvent(position, "change", (value) => {
    const nearest = orbitIndex(Math.round(value), count);
    if (nearest === frontRef.current) return;
    frontRef.current = nearest;
    setFront(nearest);
  });

  // The sheet's slide is plain CSS driven by --p on the stage.
  useMotionValueEvent(openness, "change", (value) => {
    stageRef.current?.style.setProperty("--p", value.toFixed(4));
  });

  useEffect(() => {
    const stage = stageRef.current;
    stage?.style.setProperty("--course-action-visibility", "hidden");
    const transition = reducedMotion
      ? { duration: 0.01 }
      : open ? { type: "spring" as const, stiffness: 190, damping: 28 } : { type: "spring" as const, stiffness: 300, damping: 35 };
    const controls = animate(openness, open ? 1 : 0, {
      ...transition,
      onComplete: () => {
        if (open) stage?.style.setProperty("--course-action-visibility", "visible");
      },
    });
    return () => controls.stop();
  }, [open, openness, reducedMotion]);

  useEffect(() => {
    if (sheetRef.current) sheetRef.current.scrollTop = 0;
  }, [active]);

  // The zoom-out depends on how much of the stage the sheet actually covers, so measure both.
  useEffect(() => {
    const arena = arenaRef.current;
    const sheet = sheetRef.current;
    const controls = controlsRef.current;
    if (!arena || !sheet) return;
    const measure = () => {
      const side = window.matchMedia(DESKTOP_QUERY).matches ? "right" : "bottom";
      panelView.set(viewBesidePanel(
        { width: arena.clientWidth, height: arena.clientHeight },
        { width: sheet.offsetWidth, height: sheet.offsetHeight + (side === "bottom" ? (controls?.offsetHeight ?? 0) : 0) },
        side,
      ));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(arena);
    observer.observe(sheet);
    if (controls) observer.observe(controls);
    measure();
    return () => observer.disconnect();
  }, [canNavigate, panelView]);

  const go = (direction: number) => {
    snapTo((engine.current.destination ?? Math.round(position.get())) + direction);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!canNavigate || drag.current || !event.isPrimary || event.button !== 0) return;
    drag.current = {
      id: event.pointerId, x: event.clientX, y: event.clientY, position: position.get(),
      axis: null, lastPosition: position.get(), lastTime: event.timeStamp, velocity: 0,
    };
  };

  const onPointerLeave = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (state?.id === event.pointerId && !state.axis) drag.current = null;
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    const axis = state.axis ?? (event.pointerType === "touch" && Math.abs(dy) > Math.abs(dx) ? "y" : "x");
    const travel = axis === "y" ? dy : dx;
    if (!state.axis) {
      if (Math.abs(travel) < 5) return;
      stop();
      state.position = position.get();
      state.lastPosition = position.get();
      state.axis = axis;
      event.currentTarget.setPointerCapture(event.pointerId);
      setGrabbing(true);
      setOpen(false);
    }
    const perCard = clamp(event.currentTarget.clientWidth * 0.22, 150, 340);
    const next = state.position - travel / perCard;
    position.set(next);
    const elapsed = event.timeStamp - state.lastTime;
    if (elapsed > 0) {
      const instant = (next - state.lastPosition) / (elapsed / 1000);
      state.velocity = state.velocity * 0.3 + instant * 0.7;
      state.lastPosition = next;
      state.lastTime = event.timeStamp;
    }
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    drag.current = null;
    if (!state.axis) return;
    setGrabbing(false);
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    const stale = event.timeStamp - state.lastTime > 80;
    const thrown = position.get() + (cancelled || stale ? 0 : clamp(state.velocity * 0.12, -1.2, 1.2));
    snapTo(magnetIndex(thrown, state.position));
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (suppressClick.current) return;
    const card = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-orbit-card]") : null;
    if (!card) return;
    const current = position.get();
    snapTo(current + orbitDistance(Number(card.dataset.orbitCard), current, count));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (canNavigate && ["ArrowRight", "ArrowDown"].includes(event.key)) go(1);
    else if (canNavigate && ["ArrowLeft", "ArrowUp"].includes(event.key)) go(-1);
    else if (event.key === "Enter") snapTo(position.get());
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
      data-home-path="/"
      tabIndex={-1}
      className="relative h-full min-h-0 snap-start snap-always overflow-hidden outline-none"
    >
      <div ref={stageRef} className="flex h-full flex-col overflow-hidden bg-paper text-ink [--p:0]">
        {children}
        <div ref={arenaRef} className="relative min-h-0 flex-1">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(90deg,transparent_0_calc(25%-1px),var(--line)_calc(25%-1px)_25%)] opacity-45"
          />

          <CircularGallery
            items={items}
            position={position}
            zoom={zoom}
            offsetX={offsetX}
            offsetY={offsetY}
            onReady={start}
            style={{ touchAction: "none" }}
            role="group"
            aria-roledescription="карусель"
            aria-label={canNavigate
              ? `Курсы: ${frontCourse.title}, ${front + 1} из ${count}. Стрелки влево и вправо переключают курс.`
              : frontCourse.title}
            tabIndex={0}
            className={`absolute inset-0 select-none outline-none focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-ink ${canNavigate ? (grabbing ? "cursor-grabbing" : "cursor-grab") : ""}`}
            onPointerDown={onPointerDown}
            onPointerLeave={onPointerLeave}
            onPointerMove={onPointerMove}
            onPointerUp={(event) => endDrag(event, false)}
            onPointerCancel={(event) => endDrag(event, true)}
            onLostPointerCapture={(event) => endDrag(event, true)}
            onClick={onClick}
            onKeyDown={onKeyDown}
          />

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

          {canNavigate ? <div
            ref={controlsRef}
            className="absolute inset-x-0 bottom-0 z-30 flex h-16 items-center gap-4 border-t border-ink/20 bg-paper px-[4vw] lg:inset-x-auto lg:bottom-[clamp(1rem,3.5vh,2.5rem)] lg:left-[4vw] lg:h-auto lg:border-0 lg:bg-transparent lg:px-0"
          >
            <p aria-hidden className="m-0 font-display text-[.8rem] font-semibold tracking-[.08em]">
              <span className="text-[1.6rem] tracking-[-.04em]">{two(front + 1)}</span> / {two(count)}
            </p>
            <div className="flex gap-2">
              {([[-1, "Предыдущий курс", "←"], [1, "Следующий курс", "→"]] as const).map(([direction, label, glyph]) => (
                <button
                  key={label}
                  type="button"
                  aria-label={label}
                  onClick={() => go(direction)}
                  className="grid size-11 cursor-pointer place-items-center border border-ink bg-transparent p-0 font-sans text-[1.1rem] text-ink transition-colors duration-200 hover:bg-ink hover:text-paper focus-visible:bg-ink focus-visible:text-paper disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink"
                >
                  <span aria-hidden>{glyph}</span>
                </button>
              ))}
            </div>
            <p className="m-0 hidden text-[.72rem] font-bold uppercase tracking-[.14em] text-muted sm:block">
              Прокручивайте или перетаскивайте карусель
            </p>
          </div> : null}

          <aside
            ref={sheetRef}
            aria-label="Описание курса"
            aria-live="polite"
            inert={!open}
            className={`absolute inset-x-0 z-20 translate-y-[calc((1-var(--p))*104%)] overflow-y-auto overscroll-y-contain border-t-4 border-acid bg-ink text-paper will-change-transform lg:inset-x-auto lg:bottom-0 lg:right-0 lg:top-0 lg:max-h-full lg:w-[min(30rem,38vw)] lg:translate-x-[calc((1-var(--p))*104%)] lg:translate-y-0 lg:border-l-4 lg:border-t-0 ${canNavigate ? "bottom-16 max-h-[min(60%,calc(100%_-_4rem))]" : "bottom-0 max-h-[60%]"}`}
          >
            {/* Fade the new copy in without moving the link inside the sheet. */}
            <motion.div
              key={course.slug}
              initial={reducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.45, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
              className="flex min-h-full flex-col gap-4 p-5 lg:gap-6 lg:p-10"
            >
              <div className="flex items-center justify-between gap-4">
                <p className="m-0 font-display text-[.72rem] font-semibold uppercase tracking-[.08em] text-acid">
                  Курс {two(active + 1)} / {two(count)}
                </p>
                <button
                  type="button"
                  aria-label="Скрыть описание"
                  onClick={() => setOpen(false)}
                  className="grid size-9 cursor-pointer place-items-center border border-paper/40 bg-transparent p-0 text-[1.1rem] leading-none text-paper transition-colors duration-200 hover:border-acid hover:bg-acid hover:text-ink focus-visible:border-acid focus-visible:bg-acid focus-visible:text-ink"
                >
                  <span aria-hidden>×</span>
                </button>
              </div>
              <h2 className="m-0 font-display text-[clamp(1.5rem,2.6vw,2.5rem)] font-medium leading-none tracking-[-.05em] [overflow-wrap:anywhere]">
                {course.title}
              </h2>
              {course.summary ? <p className="m-0 text-[.98rem] leading-[1.55] text-paper/80 [overflow-wrap:anywhere] lg:text-[1.05rem]">
                {course.summary}
              </p> : null}
              <HomeSectionLink
                href={`/courses/${course.slug}`}
                className="mt-auto flex items-center justify-between gap-6 bg-acid px-5 py-4 [visibility:var(--course-action-visibility,hidden)] text-[.95rem] font-bold uppercase text-ink! transition-colors duration-200 hover:bg-orange focus-visible:bg-orange"
              >
                Подробнее <span aria-hidden>↓</span>
              </HomeSectionLink>
            </motion.div>
          </aside>
        </div>
      </div>

      {/* The gallery artwork is decorative to assistive technology and crawlers; this is the same list as text. */}
      <div className="sr-only">
        <h2>Курсы</h2>
        <ol>
          {courses.map((item) => (
            <li key={item.slug}>
              {item.title}{item.summary ? ` — ${item.summary}` : ""}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
