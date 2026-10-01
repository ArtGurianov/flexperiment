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
import { RichText } from "@payloadcms/richtext-lexical/react";
import type { SerializedEditorState } from "@payloadcms/richtext-lexical/lexical";
import { lessonAccessLabel } from "@/lib/course-access-labels";
import { breadcrumbJsonLd, courseOfferJsonLd } from "@/lib/seo";
import { platformOrigin } from "@/lib/origins";

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
  const { slug } = await params;
  if (slug === buildShellSlug) notFound();
  const publicResult = await publicCourse(slug);
  const result = publicResult ?? await entitledCourse((await headers()).get("cookie") ?? "", slug);
  if (!result) notFound();
  const commercial = (await getCommercialSummaries()).get(result.course.courseRef);
  if (commercial?.withdrawn) notFound();
  const courseDescription = result.course.description as SerializedEditorState | null | undefined;
  const lessonsBySection = new Map<string, typeof result.outline.lessons>();
  for (const lesson of result.outline.lessons) {
    const key = String(relationId(lesson.section));
    lessonsBySection.set(key, [...(lessonsBySection.get(key) ?? []), lesson]);
  }
  const state = !commercial ? "Скоро" : commercial.accessModel === "FREE" ? "Бесплатный курс" : commercial.saleMode === "CLOSED" ? "Продажи закрыты" : "Доступен";
  const origin = platformOrigin();
  const jsonLd = {
    "@context": "https://schema.org", "@type": "Course",
    name: result.course.title, description: result.course.summary,
    provider: { "@type": "Organization", name: "Flexperiment" },
    ...(commercial ? { offers: courseOfferJsonLd(commercial) } : {}),
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
      {commercial?.accessModel === "PAID" && <CourseCheckout courseRef={result.course.courseRef} offerRef={commercial.offerRef} saleMode={commercial.saleMode} priceKopecks={commercial.priceKopecks} />}
      {courseDescription && <section className="richCopy courseDescription" aria-label="О курсе"><RichText data={courseDescription} /></section>}
      <section className="syllabus" aria-labelledby="syllabus-title">
        <p className="sectionNumber">Программа</p><h2 id="syllabus-title">Что внутри</h2>
        {result.outline.sections.map((section, index) => (
          <article className="syllabusSection" key={String(section.id)}>
            <header><span>{String(index + 1).padStart(2, "0")}</span><h3>{section.title}</h3></header>
            <ol>{(lessonsBySection.get(String(section.id)) ?? []).map((lesson) => <li key={lesson.lessonRef}><Link href={`/courses/${result.course.slug}/lessons/${lesson.slug}`}>{lesson.title}</Link><small>{lessonAccessLabel(commercial, Boolean(lesson.freePreview))}</small></li>)}</ol>
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
