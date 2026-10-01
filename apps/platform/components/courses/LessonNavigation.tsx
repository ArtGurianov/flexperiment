import Link from "next/link";

type NavigableLesson = {
  lessonRef?: string | null;
  slug?: string | null;
  title?: string | null;
};

export function adjacentLessons(lessons: NavigableLesson[], currentLessonRef: string) {
  const index = lessons.findIndex(({ lessonRef }) => lessonRef === currentLessonRef);
  return {
    previous: index > 0 ? lessons[index - 1] : undefined,
    next: index >= 0 && index < lessons.length - 1 ? lessons[index + 1] : undefined,
  };
}

export default function LessonNavigation({
  courseSlug,
  currentLessonRef,
  lessons,
}: {
  courseSlug: string;
  currentLessonRef: string;
  lessons: NavigableLesson[];
}) {
  const { previous, next } = adjacentLessons(lessons, currentLessonRef);
  const href = (lesson: NavigableLesson) => `/courses/${courseSlug}/lessons/${lesson.slug}`;
  return <nav className="lessonNavigation" aria-label="Навигация по курсу">
    <div>
      {previous?.slug ? <Link href={href(previous)}><span>← Предыдущий урок</span><strong>{previous.title}</strong></Link> : <span />}
    </div>
    <Link className="lessonNavigationCourse" href={`/courses/${courseSlug}`}>Все уроки</Link>
    <div>
      {next?.slug ? <Link href={href(next)}><span>Следующий урок →</span><strong>{next.title}</strong></Link> : <span />}
    </div>
  </nav>;
}
