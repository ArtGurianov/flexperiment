import adminGetLesson from "@/app/data/admin/admin-get-lesson";
import LessonForm from "./_components/LessonForm";

type Params = Promise<{
  courseId: string;
  chapterId: string;
  lessonId: string;
}>;

const LessonIdPage = async ({ params }: { params: Params }) => {
  const { courseId, chapterId, lessonId } = await params;
  console.log("courseId, chapterId, lessonId", courseId, chapterId, lessonId);
  const lesson = await adminGetLesson(lessonId);

  return <LessonForm chapterId={chapterId} data={lesson} courseId={courseId} />;
};

export default LessonIdPage;
