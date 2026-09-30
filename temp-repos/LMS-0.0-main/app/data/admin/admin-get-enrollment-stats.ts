import "server-only";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "./require-admin";

export async function adminGetEnrollmentStat() {
  await requireAdmin();

  //checks enrollments from the last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const enrollments = await prisma.enrollement.findMany({
    //give me all enrollment records where createAt is greater than or equal to last 3o days
    where: {
      createdAt: {
        gte: thirtyDaysAgo,
      },
    },
    select: {
      createdAt: true,
    },
    
    //sort in ascending order(oldest first, newest last)
    orderBy: {
      createdAt: "asc",
    },
  });

  //empty list(array) to store the final results
  const last30Days: { date: string; enrollments: number }[] = [];

  //this loops fills up the last 3o days with default entries (0 enrollments)
  for (let i = 29; i >= 0; i--) {
    const date = new Date();

    date.setDate(date.getDate() - i);

    // for each day, we create an object like { date: "2025-09-07", enrollments: 0 }
    last30Days.push({
      // .toISOString().split("T")[0] keeps only the YYYY-MM-DD part of the date.
      date: date.toISOString().split("T")[0],
      enrollments: 0,
    });
  }

  // now we go through each actual enrollments record
  enrollments.forEach((enrollment) => {
    // converts its createdAt into a simple date (yyyy-mm-dd)
    const enrollmentDate = enrollment.createdAt.toISOString().split("T")[0];

    // find which calendar entry matches that date
    const dayIndex = last30Days.findIndex((day) => day.date === enrollmentDate);

    if (dayIndex !== -1) {
      last30Days[dayIndex].enrollments++;
    }
  });

  return last30Days
}
