import { redirect } from 'next/navigation';
import { getCurrentUserWithRole } from '@/lib/auth';
import { addModuleToCourse, getCourseAdmin } from '@/actions/course';
import Link from 'next/link';

type Props = {
    params: Promise<{ slug: string }>;
};

export default async function NewModulePage(props: Props) {
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
        redirect('/admin/courses');
    }
    const course = courseRes.course as any;

    async function handleCreate(formData: FormData) {
        'use server';
        const title = String(formData.get('title') || '').trim();
        const description = String(formData.get('description') || '').trim();
        const orderRaw = String(formData.get('order') || '1').trim();
        const orderParsed = Number(orderRaw);
        const order = Number.isFinite(orderParsed) && orderParsed > 0 ? orderParsed : 1;

        if (!title) return;

        const res = await addModuleToCourse(params.slug, {
            title,
            description: description || undefined,
            order,
        });

        if (res.success) {
            redirect(`/admin/courses/${params.slug}/edit`);
        }
    }

    return (
        <div className="min-h-full gradient-bg-admin-page">
            <div className="w-full px-6 lg:px-8 py-6 lg:py-8 space-y-8">
                <div className="flex items-center justify-between gap-4">
                    <div>
                        <h1 className="text-3xl lg:text-4xl font-bold text-gray-900 mb-2">
                            Add Module
                        </h1>
                        <p className="text-base text-gray-600">
                            To course: {course.title}
                        </p>
                    </div>
                    <Link href={`/admin/courses/${params.slug}/edit`}>
                        <button className="px-5 py-2.5 gradient-button-indigo text-white rounded-xl transition-all duration-200 font-medium shadow-lg hover:shadow-xl">
                            Back to Edit Course
                        </button>
                    </Link>
                </div>

                <form action={handleCreate} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-6">
                    <div className="grid grid-cols-1 gap-6">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Module Title</label>
                                <input name="title" required className="w-full border border-gray-200 rounded-lg px-3 py-2" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Order</label>
                                <input name="order" type="number" min={1} defaultValue={(course.modules?.length || 0) + 1} className="w-full border border-gray-200 rounded-lg px-3 py-2" />
                            </div>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                            <textarea name="description" rows={4} className="w-full border border-gray-200 rounded-lg px-3 py-2" />
                        </div>
                        <div className="flex justify-end">
                            <button type="submit" className="px-5 py-2.5 gradient-button-indigo text-white rounded-xl transition-all duration-200 font-medium shadow-lg hover:shadow-xl">
                                Add Module
                            </button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
}

