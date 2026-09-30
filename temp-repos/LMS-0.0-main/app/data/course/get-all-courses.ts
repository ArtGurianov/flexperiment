import "server-only";
import { prisma } from "@/lib/prisma";

export async function getAllCoursesForPublic() {
  const data = await prisma.course.findMany({
    where: {
      status: "PUBLISHED",
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      title: true,
      price: true,
      smallDescription: true,
      slug: true,
      fileKey: true,
      category: true,
      id: true,
      level: true,
      duration: true,
    },
  });
  return data;
}

export type PublicCourseType = Awaited<ReturnType<typeof getAllCoursesForPublic>>[0];
