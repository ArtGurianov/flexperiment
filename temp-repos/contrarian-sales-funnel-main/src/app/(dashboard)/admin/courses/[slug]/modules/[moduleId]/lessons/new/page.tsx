import { redirect } from 'next/navigation';
import { getCurrentUserWithRole } from '@/lib/auth';
import { addLessonToModule, getCourseAdmin } from '@/actions/course';
import Link from 'next/link';
import NewLessonForm from '@/components/admin/NewLessonForm';

type Props = {
    params: Promise<{ slug: string; moduleId: string }>;
};

export default async function NewLessonPage(props: Props) {
    const params = await props.params;
    const user = await getCurrentUserWithRole();

    if (!user) {
        redirect('/sign-in');
    }

    if (user.role !== 'admin') {
        redirect('/dashboard');
    }

    const courseRes = await getCourseAdmin({ slug: params.slug });
    if (!courseRes.success || !courseRes.course) {
        redirect(`/admin/courses/${params.slug}/edit`);
    }
    const course = courseRes.course as any;
    const module = course.modules?.find((m: any) => m._id === params.moduleId);
    if (!module) {
        redirect(`/admin/courses/${params.slug}/edit`);
    }

    async function handleCreate(formData: FormData) {
        'use server';
        const title = String(formData.get('title') || '').trim();
        const description = String(formData.get('description') || '').trim();
        const videoUrl = String(formData.get('videoUrl') || '').trim();
        const videoDurationRaw = String(formData.get('videoDuration') || '').trim();
        const orderRaw = String(formData.get('order') || '1').trim();
        const isFree = formData.get('isFree') === 'on';

        if (!title) return;

        const parsedOrder = Number(orderRaw);
        const order = Number.isFinite(parsedOrder) && parsedOrder > 0 ? parsedOrder : 1;
        const videoDuration = videoDurationRaw ? Number(videoDurationRaw) : undefined;

        const res = await addLessonToModule(params.slug, params.moduleId, {
            title,
            description: description || undefined,
            videoUrl: videoUrl || undefined,
            videoDuration,
            order,
            isFree,
        });

        if (res.success) {
            redirect(`/admin/courses/${params.slug}/modules`);
        }
    }

    return (
        <div className="min-h-full gradient-bg-admin-page">
            <div className="w-full px-6 lg:px-8 py-6 lg:py-8 space-y-8">
                <div className="flex items-center justify-between gap-4">
                    <div>
                        <h1 className="text-3xl lg:text-4xl font-bold text-gray-900 mb-2">
                            Add Lesson
                        </h1>
                        <p className="text-base text-gray-600">
                            To module: {module.title}
                        </p>
                    </div>
                    <Link href={`/admin/courses/${params.slug}/modules`}>
                        <button className="px-5 py-2.5 gradient-button-indigo text-white rounded-xl transition-all duration-200 font-medium shadow-lg hover:shadow-xl">
                            Back to Edit Course
                        </button>
                    </Link>
                </div>

                <NewLessonForm
                    defaultOrder={(module.lessons?.length || 0) + 1}
                    onSubmit={handleCreate}
                />
            </div>
        </div>
    );
}

