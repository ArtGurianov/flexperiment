"use client";
import { PublicCourseType } from "@/app/data/course/get-all-courses";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useConstructUrl } from "@/hooks/use-construct-url";
import { School, TimerIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import React from "react";

interface iAppProps {
  data: PublicCourseType;
}
const PublicCourseCard = ({ data }: iAppProps) => {
  const thumbnailUrl = useConstructUrl(data.fileKey);
  return (
    <Card className="group relative py-0 gap-0">
      <Badge className="absolute top-2 right-2 z-10">{data.level}</Badge>
      <Image
        src={thumbnailUrl}
        alt="thumbnail image of course"
        width={600}
        height={400}
        className="w-full rounded-t-xl aspect-video h-full object-fill"
      />
      <CardContent className="p-4">
        <Link
          className="font-medium text-lg line-clamp-2 hover:underline group-hover:text-primary transition-colors"
          href={`/courses/${data.slug}`}
        >
          {data.title}
        </Link>
        <p className="line-clamp-2 text-sm text-muted-foreground leading-tight mt-2">
          {data.smallDescription}
        </p>
        <div className="mt-4 flex items-center gap-x-5">
          <div className="flex items-center gap-x-2">
            <TimerIcon className="size-6 p-1 rounded-md text-primary" />
            <p className="text-sm text-muted-foreground">{data.duration}h</p>
          </div>
          <div className="flex items-center gap-x-2">
            <School className="size-6 p-1 rounded-md text-primary" />
            <p className="text-sm text-muted-foreground">{data.category}</p>
          </div>
        </div>

        <Link
          href={`/courses/${data.slug}`}
          className={buttonVariants({ className: "w-full mt-4" })}
        >
          Learn More
        </Link>
      </CardContent>
    </Card>
  );
};

export default PublicCourseCard;

import { Skeleton } from "@/components/ui/skeleton";

export function PublicCourseCardSkeleton() {
  return (
    <Card className="rounded-2xl overflow-hidden">
      {/* Thumbnail */}
      <div className="relative w-full aspect-video">
        <Skeleton className="w-full h-full" />
        <Skeleton className="absolute top-3 right-3 w-14 h-6 rounded-md" /> {/* badge */}
      </div>

      <CardContent className="p-5 space-y-3">
        {/* Title */}
        <Skeleton className="h-6 w-3/4 rounded-md" />

        {/* Description */}
        <Skeleton className="h-4 w-full rounded-md" />
        <Skeleton className="h-4 w-5/6 rounded-md" />

        {/* Duration + Category */}
        <div className="flex items-center gap-x-6 mt-2">
          <Skeleton className="h-5 w-16 rounded-md" />
          <Skeleton className="h-5 w-20 rounded-md" />
        </div>

        {/* Button */}
        <Skeleton className="h-10 w-full rounded-lg mt-2" />
      </CardContent>
    </Card>
  );
}
