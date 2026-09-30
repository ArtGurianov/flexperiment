import "server-only";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "./require-admin";

export async function adminGetDashboardStats() {
  await requireAdmin();

  const [totalSignups, totalCustomers, totalCourses, totalLessons] = await Promise.all([
    //total signups
    prisma.user.count(),

    //total enrollment
    prisma.user.count({
      where: {
        enrollement: {
          some: {},
        },
      },
    }),

    // total courses
    prisma.course.count(),

    //total Lessons
    prisma.lesson.count(),
  ]);

  return {
    totalSignups,
    totalCustomers,
    totalCourses,
    totalLessons,
  };
}
