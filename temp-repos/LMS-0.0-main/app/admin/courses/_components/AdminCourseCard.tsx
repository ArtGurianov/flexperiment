"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useConstructUrl } from "@/hooks/use-construct-url";
import { ArrowRight, Eye, MoreVertical, PencilIcon, School, TimerIcon, Trash2 } from "lucide-react";
import Link from "next/link";

interface AdminCourseType {
  id: string;
  title: string;
  smallDescription: string;
  duration: number;
  level: string;
  price: number;
  status: string;
  slug: string;
  fileKey?: string;
}

interface iAppProps {
  data: AdminCourseType;
}

const AdminCourseCard = ({ data }: iAppProps) => {
  const thumbnailUrl = data.fileKey ? useConstructUrl(data.fileKey) : "/logo.svg";

  return (
    <Card className="group overflow-hidden rounded-3xl border-0 shadow-md hover:shadow-2xl transition-all duration-500 card-hover">
      {/* Thumbnail */}
      <div className="relative w-full h-64 overflow-hidden">
        <img
          src={thumbnailUrl}
          alt={data.title}
          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
        />

        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-black/10 to-transparent" />

        {/* Dropdown top-right */}
        <div className="absolute top-4 right-4">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="glass-effect rounded-full hover:bg-white/90 transition-all duration-300 hover:scale-110"
              >
                <MoreVertical className="w-4 h-4 text-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-48 rounded-xl border border-border/40 shadow-lg backdrop-blur-lg bg-popover text-foreground"
            >
              <DropdownMenuItem asChild>
                <Link
                  href={`/admin/courses/${data.id}/edit`}
                  className="flex items-center gap-2 rounded-lg hover:bg-primary/10 transition-colors"
                >
                  <PencilIcon className="w-4 h-4" /> Edit Course
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link
                  href={`/courses/${data.slug}`}
                  className="flex items-center gap-2 rounded-lg hover:bg-primary/10 transition-colors"
                >
                  <Eye className="w-4 h-4" /> Preview
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border/50" />
              <DropdownMenuItem asChild>
                <Link
                  href={`/admin/courses/${data.id}/delete`}
                  className="flex items-center gap-2 rounded-lg text-destructive hover:bg-destructive/10 transition-colors"
                >
                  <Trash2 className="w-4 h-4" /> Delete Course
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Status badge → bottom-left */}
        <div className="absolute bottom-4 left-4">
          <span
            className={`px-3 py-1 rounded-full text-xs font-semibold backdrop-blur-md border shadow-sm ${
              data.status === "PUBLISHED"
                ? "text-green-700 bg-green-100/90 border-green-200"
                : "text-orange-700 bg-orange-100/90 border-orange-200"
            }`}
          >
            {data.status === "PUBLISHED" ? "Published" : "Draft"}
          </span>
        </div>
      </div>

      {/* Content */}
      <CardContent className="p-8">
        {/* Title */}
        <h3 className="text-xl font-bold text-foreground mb-3 group-hover:text-primary transition-colors duration-300 line-clamp-2">
          {data.title}
        </h3>

        {/* Description */}
        <p className="text-muted-foreground text-sm leading-relaxed mb-6 line-clamp-3">
          {data.smallDescription}
        </p>

        {/* Meta info */}
        <div className="flex items-center gap-6 mb-6 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-primary/10">
              <TimerIcon className="w-4 h-4 text-primary" />
            </div>
            <span className="font-medium">{data.duration} min</span>
          </div>

          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-primary/10">
              <School className="w-4 h-4 text-primary" />
            </div>
            <span className="font-medium capitalize">{data.level}</span>
          </div>
        </div>

        {/* Price */}
        <div className="flex items-center justify-between mb-8">
          <div className="text-2xl font-extrabold bg-gradient-to-r from-primary to-purple-600 bg-clip-text text-transparent">
            ${data.price}
          </div>
          <span className="text-sm text-muted-foreground">Course Price</span>
        </div>

        {/* CTA → Edit */}
        <Link href={`/admin/courses/${data.id}/edit`}>
          <Button className="w-full btn-gradient text-white font-semibold py-3 rounded-xl shadow-md hover:shadow-lg transition-all duration-300 group">
            <span className="flex items-center justify-center gap-2">
              Edit Course
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
            </span>
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
};

export default AdminCourseCard;

export function AdminCourseCardSkeleton() {
  return (
    <div className="space-y-16">
      {/* Stats Skeleton */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {[...Array(3)].map((_, i) => (
          <Card key={i} className="rounded-3xl border-0 shadow-md animate-pulse">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-4">
                <Skeleton className="w-12 h-12 rounded-2xl" />
                <div>
                  <Skeleton className="h-8 w-24 mb-2 rounded-md" />
                  <Skeleton className="h-4 w-20 rounded-md" />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Skeleton className="h-2 w-full rounded-full" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Courses Grid Skeleton */}
      <div className="space-y-8">
        <Skeleton className="h-8 w-64 rounded-md mb-4" /> {/* "Your Course Collection" title */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {[...Array(6)].map((_, i) => (
            <Card key={i} className="animate-pulse rounded-3xl border-0 shadow-md">
              <div className="w-full h-64 bg-muted/50 rounded-t-3xl relative">
                <Skeleton className="w-full h-full rounded-t-3xl" />
                <Skeleton className="absolute top-4 right-4 w-8 h-8 rounded-full" />
              </div>
              <CardContent className="p-6 space-y-4">
                <Skeleton className="h-6 w-3/4 rounded-md" />
                <Skeleton className="h-4 w-1/2 rounded-md" />
                <Skeleton className="h-10 w-full rounded-xl" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
