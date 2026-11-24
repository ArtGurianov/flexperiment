import Link from "next/link";
import { connection } from "next/server";
import { publicCourses } from "@/lib/content/public";
import HomePolicyLinks from "./HomePolicyLinks";
import CourseOrbit from "./CourseOrbit";
import { COURSE_IMAGE_MANIFEST } from "@/lib/public-media";
import type { OrbitCourse } from "./orbit-course";

function HomeNavigation() {
  return (
    <>
      <nav className="nav" aria-label="Основная навигация">
        <Link className="wordmark" href="/">FLEXPERIMENT<span>®</span></Link>
        <div className="navLinks"><Link href="/courses">Курсы</Link><Link href="/account">Мои курсы</Link></div>
      </nav>
      <HomePolicyLinks className="shrink-0 justify-end px-[4vw] pt-2" />
    </>
  );
}

export function HomeHero({ catalogueStatus }: { catalogueStatus?: string }) {
  return (
    <div data-home-path="/" tabIndex={-1} className="h-full snap-start snap-always overflow-y-auto outline-none">
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
    </div>
  );
}

export default async function HomeCourseHero() {
  // Read the current committed Commerce catalogue on the request, as on /courses.
  await connection();
  let courses: OrbitCourse[];
  let catalogueEmpty = false;
  try {
    const published = new Map((await publicCourses()).map(({ course }) => [course.courseRef, course]));
    catalogueEmpty = published.size === 0;
    courses = COURSE_IMAGE_MANIFEST.flatMap(({ courseRef, path }) => {
      const course = published.get(courseRef);
      if (!course) return [];
      const { slug, title, summary } = course;
      return [{ coverPath: path, slug, title, summary }];
    });
  } catch {
    return <HomeHero catalogueStatus="Каталог временно недоступен." />;
  }
  if (courses.length === 0) return <HomeHero catalogueStatus={catalogueEmpty ? "Первый курс готовится к публикации." : undefined} />;

  return <CourseOrbit courses={courses}><HomeNavigation /></CourseOrbit>;
}
