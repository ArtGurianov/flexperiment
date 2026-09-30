import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { enrollmentId } = await req.json();
    if (!enrollmentId) {
      return NextResponse.json({ status: "error", message: "No enrollment ID provided" }, { status: 400 });
    }

    await prisma.enrollement.update({
      where: { id: enrollmentId },
      data: { status: "ACTIVE" },
    });

    return NextResponse.json({ status: "success", message: "Enrollment activated" });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ status: "error", message: "Something went wrong" }, { status: 500 });
  }
}
