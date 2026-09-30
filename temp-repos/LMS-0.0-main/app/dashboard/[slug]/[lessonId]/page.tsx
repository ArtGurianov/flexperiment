import { getLessonContent } from "@/app/data/course/get-lesson-content"
import CourseContent from "./_components/CourseContent"
import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"

type Params = Promise<{ lessonId: string }>

export default async function LessonContentPage({ params }: { params: Params }) {
  const { lessonId } = await params

  return (
    <Suspense fallback={<LessonContentSkeleton />}>
      <LessonContentLoader lessonId={lessonId} />
    </Suspense>
  )
}

async function LessonContentLoader({ lessonId }: { lessonId: string }) {
  const data = await getLessonContent(lessonId)
  return <CourseContent data={data} />
}

// Skeleton Component
function LessonContentSkeleton() {
  return (
    <div className="flex flex-col h-full bg-background px-6 py-4 space-y-6">
      {/* Video Skeleton */}
      <div className="aspect-video w-full rounded-lg overflow-hidden">
        <Skeleton className="h-full w-full" />
      </div>

      {/* Button Skeleton */}
      <div className="flex justify-end border-b pb-4">
        <Skeleton className="h-10 w-40 rounded-md" />
      </div>

      {/* Lesson Title + Description Skeleton */}
      <div className="space-y-3">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </div>
  )
}
