'use client'

import { Button } from "@/components/ui/button"
import { tryCatch } from "@/hooks/try-catch"
import { useTransition } from "react"
import { enrollInCourseAction } from "../actions"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"

const EnrollmentButton = ({ courseId }: { courseId: string }) => {
    const [isPending, startTransition] = useTransition()
    function onSubmit() {
        startTransition(async () => {
            const { data: result, error } = await tryCatch(enrollInCourseAction(courseId))

            if (error) {
                toast.error('Something went wrong. Please try again.')
                return
            }

            if (result?.status === "success") {
                toast.success(result.message)
                return
            } else if (result?.status === "error") {
                toast.error(result.message)
                return
            }
        })
    }
    return (
        <div>
            <Button className="w-full" onClick={onSubmit} disabled={isPending}>
                {isPending ? (
                    <>
                        <Loader2 className='size-4 animate-spin' />
                        Loading...
                    </>
                ) : (
                    'Enroll Now'
                )}
            </Button>
        </div>
    )
}

export default EnrollmentButton