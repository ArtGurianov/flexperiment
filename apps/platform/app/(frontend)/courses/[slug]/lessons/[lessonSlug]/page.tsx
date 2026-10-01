import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { Suspense } from "react";
import LessonPlayer from "@/components/kinescope/LessonPlayer";
import LessonNavigation from "@/components/courses/LessonNavigation";
import { publicLesson } from "@/lib/content/public";
import { entitledLesson } from "@/lib/content/entitled";
import { getCommercialSummaries } from "@/lib/commerce-summary";
import { lessonAccessLabel } from "@/lib/course-access-labels";
import { RichText } from "@payloadcms/richtext-lexical/react";
import type { SerializedEditorState } from "@payloadcms/richtext-lexical/lexical";
import { breadcrumbJsonLd, lessonIsAccessibleForFree } from "@/lib/seo";

type Props = { params: Promise<{ slug: string; lessonSlug: string }> };
const buildShellSlug = "__build-shell__";

export function generateStaticParams() { return [{ slug: buildShellSlug, lessonSlug: buildShellSlug }]; }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, lessonSlug } = await params;
  if (slug === buildShellSlug || lessonSlug === buildShellSlug) return { robots: { index: false, follow: false } };
  const result = await publicLesson(slug, lessonSlug);
  if (!result) return { robots: { index: false, follow: false } };
  const description = result.lesson.seo?.description || `${result.lesson.title} — урок курса «${result.course.title}».`;
  return {
    title: result.lesson.seo?.title || result.lesson.title,
    description,
    robots: result.lesson.description ? undefined : { index: false, follow: true },
    alternates: { canonical: `/courses/${slug}/lessons/${lessonSlug}` },
    openGraph: { title: result.lesson.title, description, type: "video.other", url: `/courses/${slug}/lessons/${lessonSlug}`, locale: "ru_RU" },
  };
}

async function LessonContent({ params }: Props) {
  const { slug, lessonSlug } = await params;
  if (slug === buildShellSlug || lessonSlug === buildShellSlug) notFound();
  const publicResult = await publicLesson(slug, lessonSlug);
  const result = publicResult ?? await entitledLesson((await headers()).get("cookie") ?? "", slug, lessonSlug);
  if (!result) notFound();
  const commercial = (await getCommercialSummaries()).get(result.course.courseRef);
  if (commercial?.withdrawn) notFound();
  const lessonDescription = result.lesson.description as SerializedEditorState | null | undefined;
  const origin = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3001";
  const jsonLd = {
    "@context": "https://schema.org", "@type": "LearningResource",
    name: result.lesson.title, isPartOf: { "@type": "Course", name: result.course.title },
    isAccessibleForFree: lessonIsAccessibleForFree(commercial, Boolean(result.lesson.freePreview)),
  };
  const breadcrumbs = breadcrumbJsonLd(origin, [
    { name: "Главная", path: "/" },
    { name: "Курсы", path: "/courses" },
    { name: result.course.title, path: `/courses/${slug}` },
    { name: result.lesson.title, path: `/courses/${slug}/lessons/${lessonSlug}` },
  ]);
  return <main className="lessonPage"><nav className="nav"><Link className="wordmark" href="/">FLEXPERIMENT<span>®</span></Link><Link href={`/courses/${slug}`}>← {result.course.title}</Link></nav><header className="lessonHeader"><p className="eyebrow">{result.section.title}</p><h1>{result.lesson.title}</h1><p className="lessonAccess">{lessonAccessLabel(commercial, Boolean(result.lesson.freePreview))}</p></header>{lessonDescription && <section className="richCopy lessonDescription" aria-label="Об уроке"><RichText data={lessonDescription} /></section>}<section className="playerSection"><LessonPlayer lessonRef={result.lesson.lessonRef} title={result.lesson.title} /></section><LessonNavigation courseSlug={slug} currentLessonRef={result.lesson.lessonRef} lessons={result.outline.lessons} /><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} /><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbs).replace(/</g, "\\u003c") }} /></main>;
}

export default function LessonPage(props: Props) {
  return <Suspense fallback={<main className="lessonPage"><p className="emptyState">Загружаем урок…</p></main>}><LessonContent {...props} /></Suspense>;
}
