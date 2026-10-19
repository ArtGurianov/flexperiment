import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { headers } from "next/headers";
import { Suspense } from "react";
import LessonPlayer from "@/components/kinescope/LessonPlayer";
import LessonNavigation from "@/components/courses/LessonNavigation";
import { publicLesson } from "@/lib/content/public";
import { viewerLesson } from "@/lib/content/entitled";
import { lessonAccessLabel } from "@/lib/course-access-labels";
import LexicalReadOnly from "@/components/courses/LexicalReadOnly";
import { jsonLdScript, lessonJsonLd, lessonMetadata } from "@/lib/seo";
import { platformOrigin } from "@/lib/origins";

type Props = { params: Promise<{ slug: string; lessonSlug: string }> };
const buildShellSlug = "__build-shell__";

export function generateStaticParams() { return [{ slug: buildShellSlug, lessonSlug: buildShellSlug }]; }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, lessonSlug } = await params;
  if (slug === buildShellSlug || lessonSlug === buildShellSlug) return { robots: { index: false, follow: false } };
  return lessonMetadata(await publicLesson(slug, lessonSlug));
}

async function LessonContent({ params }: Props) {
  await connection();
  const { slug, lessonSlug } = await params;
  if (slug === buildShellSlug || lessonSlug === buildShellSlug) notFound();
  const result = await viewerLesson((await headers()).get("cookie") ?? "", slug, lessonSlug);
  if (!result) notFound();
  const { commercial } = result;
  const lessonDescription = result.lesson.description;
  const jsonLd = lessonJsonLd(platformOrigin(), result);
  return <main className="lessonPage"><nav className="nav"><Link className="wordmark" href="/">FLEXPERIMENT<span>®</span></Link><Link href={`/courses/${slug}`}>← {result.course.title}</Link></nav><header className="lessonHeader"><p className="eyebrow">{result.section.title}</p><h1>{result.lesson.title}</h1><p className="lessonAccess">{lessonAccessLabel(commercial, result.lesson.freePreview)}</p></header>{lessonDescription != null && <section className="richCopy lessonDescription" aria-label="Об уроке"><LexicalReadOnly data={lessonDescription} /></section>}<section className="playerSection"><LessonPlayer lessonRef={result.lesson.lessonRef} title={result.lesson.title} /></section><LessonNavigation courseSlug={slug} currentLessonRef={result.lesson.lessonRef} lessons={result.outline.lessons} />{jsonLd.map((value, index) => <script key={index} type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(value) }} />)}</main>;
}

export default function LessonPage(props: Props) {
  return <Suspense fallback={<main className="lessonPage"><p className="emptyState">Загружаем урок…</p></main>}><LessonContent {...props} /></Suspense>;
}
