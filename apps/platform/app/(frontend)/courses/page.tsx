import Link from "next/link";
import { publicCourses } from "@/lib/content/public";
import CourseSearch from "@/components/search/CourseSearch";
import { Suspense } from "react";
import { connection } from "next/server";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Курсы",
  description: "Авторские видео-курсы Арта Гурьянова по флексингу: техника, музыкальность и собственный язык движения.",
  alternates: { canonical: "/courses" },
  openGraph: {
    title: "Курсы по флексингу",
    description: "Авторские видео-курсы Арта Гурьянова по флексингу.",
    url: "/courses",
    type: "website",
    locale: "ru_RU",
  },
};

const money = (kopecks: number) => new Intl.NumberFormat("ru-RU", {
  style: "currency", currency: "RUB", maximumFractionDigits: 0,
}).format(kopecks / 100);

async function CourseGrid() {
  // The Commerce graph is read at request time; there is no content ISR in the closed canary.
  await connection();
  const courses = await publicCourses();
  return <section className="courseGrid" aria-label="Опубликованные курсы">
    {courses.map(({ course, commercial }, index) => {
      const commercialLabel = commercial.accessModel === "FREE" ? "Бесплатно" : commercial.saleMode === "CLOSED" ? "Продажи закрыты" : commercial.priceKopecks === null ? "Скоро" : money(commercial.priceKopecks);
      return (
        <article className="courseCard" key={course.courseRef}>
          <div className="courseCardNumber">{String(index + 1).padStart(2, "0")}</div>
          <div><p className="courseMeta">{commercialLabel}</p><h2><Link href={`/courses/${course.slug}`}>{course.title}</Link></h2><p>{course.summary}</p></div>
          <Link className="courseArrow" aria-label={`Открыть курс ${course.title}`} href={`/courses/${course.slug}`}>↗</Link>
        </article>
      );
    })}
    {courses.length === 0 && <p className="emptyState">Первый курс готовится к публикации.</p>}
  </section>;
}

export default function CoursesPage() {
  return (
    <main className="listing">
      <nav className="nav" aria-label="Основная навигация">
        <Link className="wordmark" href="/">FLEXPERIMENT<span>®</span></Link>
        <div className="navLinks"><Link aria-current="page" href="/courses">Курсы</Link><Link href="/account">Мои курсы</Link></div>
      </nav>
      <header className="listingHeader">
        <p className="eyebrow">Каталог курсов</p>
        <h1>Курсы</h1>
        <p>Техника, музыкальность и собственный язык движения. Каждый курс остаётся у вас без ограничения по времени.</p>
        <CourseSearch />
      </header>
      <Suspense fallback={<section className="courseGrid" aria-label="Загрузка каталога"><p className="emptyState">Загружаем каталог…</p></section>}><CourseGrid /></Suspense>
    </main>
  );
}
