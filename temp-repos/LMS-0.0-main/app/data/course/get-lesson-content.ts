import 'server-only'
import { prisma } from "@/lib/prisma";
import { reequireUser } from "../user/require-user";
import { notFound } from "next/navigation";

export async function getLessonContent(lessonId: string) {
  const session = await reequireUser();

  const lesson = await prisma.lesson.findUnique({
    where: {
      id: lessonId,
    },
    select: {
      id: true,
      title: true,
      description: true,
      thumbnailKey: true,
      videoKey: true,
      position: true,
      lessonProgress: {
        where: {
          userId: session.id
        },
        select: {
          lessonId: true,
          completed: true
        }
      },
      Chapter: {
        select: {
          courseId: true,
          Course: {
            select: {
              slug: true
            }
          }
        },
      },
    },
  });

  if (!lesson) {
    return notFound();
  }

  const enrollment = await prisma.enrollement.findUnique({
    where: {
      userId_courseId: {
        userId: session.id,
        courseId: lesson.Chapter.courseId,
      },
    },
    select: {
      status: true,
    },
  });

  if (!enrollment || enrollment.status !== "ACTIVE") {
    return notFound();
  }

  return lesson;
}

export type LessonContentType = Awaited<ReturnType<typeof getLessonContent>>;
