import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { Suspense } from "react";
import { publicCourse } from "@/lib/content/public";
import { entitledCourse } from "@/lib/content/entitled";
import { getCommercialSummaries } from "@/lib/commerce-summary";
import { relationId } from "@/lib/content/editorial";
import CourseCheckout from "@/components/checkout/CourseCheckout";

type Props = { params: Promise<{ slug: string }> };
const buildShellSlug = "__build-shell__";

// Production editorial data is not copied into an image build. Cache
// Components emits the param shell here and upgrades each course on demand.
export function generateStaticParams() { return [{ slug: buildShellSlug }]; }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  if (slug === buildShellSlug) return { robots: { index: false, follow: false } };
  const result = await publicCourse(slug);
  if (!result) return { robots: { index: false, follow: false } };
  return {
    title: result.course.title,
    description: result.course.summary,
    alternates: { canonical: `/courses/${result.course.slug}` },
    openGraph: { title: result.course.title, description: result.course.summary, type: "website" },
  };
}

async function CourseContent({ params }: Props) {
  const { slug } = await params;
  if (slug === buildShellSlug) notFound();
  const publicResult = await publicCourse(slug);
  const result = publicResult ?? await entitledCourse((await headers()).get("cookie") ?? "", slug);
  if (!result) notFound();
  const commercial = (await getCommercialSummaries()).get(result.course.courseRef);
  if (commercial?.withdrawn) notFound();
  const lessonsBySection = new Map<string, typeof result.outline.lessons>();
  for (const lesson of result.outline.lessons) {
    const key = String(relationId(lesson.section));
    lessonsBySection.set(key, [...(lessonsBySection.get(key) ?? []), lesson]);
  }
  const state = !commercial ? "Скоро" : commercial.accessModel === "FREE" ? "Бесплатный курс" : commercial.saleMode === "CLOSED" ? "Продажи закрыты" : "Доступен";
  const jsonLd = {
    "@context": "https://schema.org", "@type": "Course",
    name: result.course.title, description: result.course.summary,
    provider: { "@type": "Organization", name: "Flexperiment" },
    ...(commercial ? { offers: {
      "@type": "Offer", priceCurrency: "RUB",
      price: commercial.accessModel === "FREE" ? "0" : commercial.priceKopecks === null ? undefined : String(commercial.priceKopecks / 100),
      availability: commercial.saleMode === "PUBLIC" ? "https://schema.org/InStock" : "https://schema.org/PreOrder",
    } } : {}),
  };
  return (
    <main className="courseDetail">
      <nav className="nav" aria-label="Основная навигация"><Link className="wordmark" href="/">FLEXPERIMENT<span>®</span></Link><Link href="/courses">← Все курсы</Link></nav>
      <header className="courseHero"><p className="eyebrow">{state}</p><h1>{result.course.title}</h1><p>{result.course.summary}</p></header>
      {commercial?.accessModel === "PAID" && <CourseCheckout courseRef={result.course.courseRef} offerRef={commercial.offerRef} saleMode={commercial.saleMode} priceKopecks={commercial.priceKopecks} />}
      <section className="syllabus" aria-labelledby="syllabus-title">
        <p className="sectionNumber">Программа</p><h2 id="syllabus-title">Что внутри</h2>
        {result.outline.sections.map((section, index) => (
          <article className="syllabusSection" key={String(section.id)}>
            <header><span>{String(index + 1).padStart(2, "0")}</span><h3>{section.title}</h3></header>
            <ol>{(lessonsBySection.get(String(section.id)) ?? []).map((lesson) => <li key={lesson.lessonRef}><Link href={`/courses/${result.course.slug}/lessons/${lesson.slug}`}>{lesson.title}</Link>{lesson.freePreview && <small>превью</small>}</li>)}</ol>
          </article>
        ))}
      </section>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
    </main>
  );
}

export default function CoursePage(props: Props) {
  return <Suspense fallback={<main className="courseDetail"><p className="emptyState">Загружаем курс…</p></main>}><CourseContent {...props} /></Suspense>;
}
