import Link from "next/link";
import { connection } from "next/server";
import { publicCourses } from "@/lib/content/public";
import CourseOrbit from "./CourseOrbit";
import type { OrbitCourse } from "./orbit-course";

// Each featured card has its own canvas texture. The navigation links to the full catalogue.
const FEATURED_COURSE_LIMIT = 10;

function HomeNavigation() {
  return (
    <nav className="nav" aria-label="Основная навигация">
      <Link className="wordmark" href="/">FLEXPERIMENT<span>®</span></Link>
      <div className="navLinks"><Link href="/courses">Курсы</Link><Link href="/account">Мои курсы</Link></div>
    </nav>
  );
}

export function HomeHero({ catalogueStatus }: { catalogueStatus?: string }) {
  return (
    <>
      <HomeNavigation />
      <section className="relative isolate grid min-h-[calc(100svh-78px)] content-between overflow-hidden px-[4vw] pt-[7vh] pb-[5vh]" aria-labelledby="home-title">
        <p className="eyebrow">Онлайн-школа флексинга · Новосибирск / весь мир</p>
        <h1 id="home-title" className="my-[6vh] font-display text-[clamp(2.1rem,9.7vw,10rem)] font-bold uppercase leading-[.88] tracking-[-.08em]">
          Тело знает.<br />
          <em className="not-italic text-transparent [-webkit-text-stroke:1.5px_var(--ink)]">Дай ему язык.</em>
        </h1>
        <div className="grid items-end gap-6 md:grid-cols-[minmax(260px,520px)_auto]">
          <div>
            <p className="m-0 text-[clamp(1.05rem,1.7vw,1.4rem)] leading-relaxed">
              Авторские видео-курсы Арта Гурьянова — от точной базы до собственного способа двигаться.
            </p>
            {catalogueStatus && <p className="mb-0 text-muted">{catalogueStatus}</p>}
          </div>
          <Link className="primary" href="/courses">Смотреть курсы <span aria-hidden>↗</span></Link>
        </div>
        <div aria-hidden className="pointer-events-none absolute -right-[13vw] -bottom-[17vw] -z-10 size-[48vw] rounded-full bg-acid" />
      </section>
    </>
  );
}

export default async function HomeCourseHero() {
  // Read the current committed Commerce catalogue on the request, as on /courses.
  await connection();
  let courses: OrbitCourse[];
  try {
    courses = (await publicCourses()).slice(0, FEATURED_COURSE_LIMIT).map(({ course: { slug, title, summary } }) => ({
      slug, title, summary, href: `/courses/${encodeURIComponent(slug)}`,
    }));
  } catch {
    return <HomeHero catalogueStatus="Каталог временно недоступен." />;
  }
  if (courses.length === 0) return <HomeHero catalogueStatus="Первый курс готовится к публикации." />;

  return <CourseOrbit courses={courses}><HomeNavigation /></CourseOrbit>;
}
