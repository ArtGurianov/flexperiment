import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { publicCourse } from "@/lib/content/public";
import CourseCheckout from "@/components/checkout/CourseCheckout";
import LexicalReadOnly from "@/components/courses/LexicalReadOnly";
import { lessonAccessLabel } from "@/lib/course-access-labels";
import { breadcrumbJsonLd, courseOfferJsonLd } from "@/lib/seo";
import { platformOrigin } from "@/lib/origins";

type Props = { params: Promise<{ slug: string }> };
const buildShellSlug = "__build-shell__";

// Build an empty param shell; Commerce content is fetched only for a request.
export function generateStaticParams() { return [{ slug: buildShellSlug }]; }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  if (slug === buildShellSlug) return { robots: { index: false, follow: false } };
  const result = await publicCourse(slug);
  if (!result) return { robots: { index: false, follow: false } };
  const title = result.course.seo?.title || result.course.title;
  const description = result.course.seo?.description || result.course.summary;
  return {
    title,
    description,
    alternates: { canonical: `/courses/${result.course.slug}` },
    openGraph: { title, description, type: "website", url: `/courses/${result.course.slug}`, locale: "ru_RU" },
  };
}

async function CourseContent({ params }: Props) {
  await connection();
  const { slug } = await params;
  if (slug === buildShellSlug) notFound();
  const result = await publicCourse(slug);
  if (!result) notFound();
  const { commercial } = result;
  const courseDescription = result.course.description;
  const lessonsBySection = new Map<string, typeof result.outline.lessons>();
  for (const lesson of result.outline.lessons) {
    const key = lesson.sectionRef;
    lessonsBySection.set(key, [...(lessonsBySection.get(key) ?? []), lesson]);
  }
  const state = commercial.accessModel === "FREE" ? "Бесплатный курс" : commercial.saleMode === "CLOSED" ? "Продажи закрыты" : "Доступен";
  const origin = platformOrigin();
  const jsonLd = {
    "@context": "https://schema.org", "@type": "Course",
    name: result.course.title, description: result.course.summary,
    provider: { "@type": "Organization", name: "Flexperiment" },
    offers: courseOfferJsonLd(commercial),
  };
  const breadcrumbs = breadcrumbJsonLd(origin, [
    { name: "Главная", path: "/" },
    { name: "Курсы", path: "/courses" },
    { name: result.course.title, path: `/courses/${result.course.slug}` },
  ]);
  return (
    <main className="courseDetail">
      <nav className="nav" aria-label="Основная навигация"><Link className="wordmark" href="/">FLEXPERIMENT<span>®</span></Link><Link href="/courses">← Все курсы</Link></nav>
      <header className="courseHero"><p className="eyebrow">{state}</p><h1>{result.course.title}</h1><p>{result.course.summary}</p></header>
      {commercial.accessModel === "PAID" && <CourseCheckout courseRef={result.course.courseRef} offerRef={commercial.offerRef} saleMode={commercial.saleMode} priceKopecks={commercial.priceKopecks} />}
      {courseDescription != null && <section className="richCopy courseDescription" aria-label="О курсе"><LexicalReadOnly data={courseDescription} /></section>}
      <section className="syllabus" aria-labelledby="syllabus-title">
        <p className="sectionNumber">Программа</p><h2 id="syllabus-title">Что внутри</h2>
        {result.outline.sections.map((section, index) => (
          <article className="syllabusSection" key={section.sectionRef}>
            <header><span>{String(index + 1).padStart(2, "0")}</span><h3>{section.title}</h3></header>
            <ol>{(lessonsBySection.get(section.sectionRef) ?? []).map((lesson) => <li key={lesson.lessonRef}><Link href={`/courses/${result.course.slug}/lessons/${lesson.slug}`}>{lesson.title}</Link><small>{lessonAccessLabel(commercial, lesson.freePreview)}</small></li>)}</ol>
          </article>
        ))}
      </section>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbs).replace(/</g, "\\u003c") }} />
    </main>
  );
}

export default function CoursePage(props: Props) {
  return <Suspense fallback={<main className="courseDetail"><p className="emptyState">Загружаем курс…</p></main>}><CourseContent {...props} /></Suspense>;
}
