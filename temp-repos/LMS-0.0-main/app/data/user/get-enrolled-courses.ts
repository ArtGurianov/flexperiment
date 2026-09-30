import 'server-only'
import { prisma } from "@/lib/prisma";
import { reequireUser } from "./require-user";

export async function getEnrolledCourses() {
  const user = await reequireUser();

  const data = await prisma.enrollement.findMany({
    where: {
      userId: user.id,
      status: "ACTIVE",
    },
    select: {
      Course: {
        select: {
          id: true,
          smallDescription: true,
          title: true,
          fileKey: true,
          level: true,
          slug: true,
          duration: true,
          chapter: {
            select: {
              id: true,
              lesson: {
                select: {
                  id: true,
                  lessonProgress: {
                    where: {
                      userId: user.id
                    },
                    select: {
                      id: true,
                      completed: true,
                      lessonId: true
                    }
                  }
                },
              },
            },
          },
        },
      },
    },
  });
  return data;
}

export type EnrolledCourseType = Awaited<ReturnType<typeof getEnrolledCourses>>[0];
