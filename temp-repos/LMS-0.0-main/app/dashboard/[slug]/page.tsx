import { getCourseSidebarData } from "@/app/data/course/get-course-sidebar-data"
import { redirect } from "next/navigation"
import { BookOpen } from "lucide-react"

interface iAppProps {
  params: Promise<{ slug: string }>
}

export default async function CourseSlugRoute({ params }: iAppProps) {
  const { slug } = await params

  const course = await getCourseSidebarData(slug)
  const firstChapter = course.course.chapter[0]
  const firstLesson = firstChapter?.lesson[0]

  if (firstLesson) {
    redirect(`/dashboard/${slug}/${firstLesson.id}`)
  }

  return (
    <div className="flex flex-col items-center justify-center h-full text-center space-y-4 px-4">
      {/* Icon */}
      <div className="flex items-center justify-center w-16 h-16 rounded-full bg-muted">
        <BookOpen className="w-8 h-8 text-muted-foreground" />
      </div>

      {/* Heading */}
      <h2 className="text-2xl font-bold">No Lessons Available</h2>

      {/* Subtext */}
      <p className="text-muted-foreground max-w-md">
        This course doesn’t have any lessons yet. Please check back later as new
        content is added.
      </p>
    </div>
  )
}
