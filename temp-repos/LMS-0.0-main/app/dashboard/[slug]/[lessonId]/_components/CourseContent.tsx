'use client'
import { LessonContentType } from '@/app/data/course/get-lesson-content'
import { Button } from '@/components/ui/button'
import { tryCatch } from '@/hooks/try-catch'
import { useConstructUrl } from '@/hooks/use-construct-url'
import { BookIcon, CheckCircle } from 'lucide-react'
import React, { useTransition } from 'react'
import { markLessonComplete } from '../actions'
import { toast } from 'sonner'
import { useConfetti } from '@/hooks/use.confetti'

interface iAppProps {
  data: LessonContentType
}

const CourseContent = ({ data }: iAppProps) => {
  function VideoPlayer({
    thumbnailKey,
    videoKey,
  }: {
    thumbnailKey: string
    videoKey: string
  }) {
    const videoUrl = videoKey ? useConstructUrl(videoKey) : null
    const thumbnailUrl = thumbnailKey ? useConstructUrl(thumbnailKey) : null

    if (!videoUrl) {
      return (
        <div className="flex flex-col items-center justify-center space-y-2 text-muted-foreground">
          <BookIcon className="w-10 h-10" />
          <p className="text-sm">This lesson doesn’t have a video yet.</p>
        </div>
      )
    }

    return (
      <video
        controls
        poster={thumbnailUrl || undefined}
        className="w-full h-full rounded-lg object-fill"
      >
        <source src={videoUrl} type="video/mp4" />
        <source src={videoUrl} type="video/webm" />
        <source src={videoUrl} type="video/ogg" />
        Your browser does not support the video tag.
      </video>
    )
  }

  const [isPending, startTransition] = useTransition()

  const { triggerConfetti } = useConfetti()
  const onSubmit = () => {
    startTransition(async () => {
      const { data: result, error } = await tryCatch(markLessonComplete(data.id, data.Chapter.Course.slug));
      if (error) {
        toast.error("Failed to mark completed. Please try again.");
        return;
      }
      if (result.status === "success") {
        toast.success(result.message);
        triggerConfetti()

      } else if (result.status === "error") {
        toast.error(result.message);
      }
    });
  };

  return (
    <div className="flex flex-col h-full bg-background px-6 py-4 space-y-6">
      {/* Video Section */}
      <div className="aspect-video w-full bg-muted rounded-lg overflow-hidden flex items-center justify-center">
        <VideoPlayer
          thumbnailKey={data.thumbnailKey ?? ''}
          videoKey={data.videoKey ?? ''}
        />
      </div>

      {/* Completion Button */}
      <div className="flex justify-end border-b pb-4">
        {
          data.lessonProgress.length > 0 ?
            (
              <Button variant='outline' className='bg-green-500/10 text-green-500 hover:text-green-600'>
                <CheckCircle className='size-4 mr-2 text-green-500' />
                Completed
              </Button>
            ) : <Button onClick={onSubmit} variant="outline" disabled={isPending} className="flex items-center gap-2">
              <CheckCircle className="size-4 text-green-500" />
              Mark as Completed
            </Button>}

      </div>

      {/* Lesson Details */}
      <div className="space-y-3">
        <h2 className="text-xl font-semibold">{data.title}</h2>
        {data.description && (
          <div
            className="prose prose-sm max-w-none dark:prose-invert text-muted-foreground"
            dangerouslySetInnerHTML={{ __html: data.description }}
          />
        )}
      </div>
    </div>
  )
}

export default CourseContent
