import { redirect } from 'next/navigation';
import { getCurrentUserWithRole } from '@/lib/auth';
import Link from 'next/link';
import { getAllCoursesAdmin, setCoursePublishStatus, deleteCourse } from '@/actions/course';
import CoursesTable from '@/components/admin/CoursesTable';

export default async function AdminCoursesPage() {
    const user = await getCurrentUserWithRole();

    if (!user) {
        redirect('/sign-in');
    }

    if (user.role !== 'admin') {
        redirect('/dashboard');
    }

    const res = await getAllCoursesAdmin();
    const courses = res.success ? res.courses : [];

    async function togglePublish(formData: FormData) {
        'use server';
        const slug = String(formData.get('slug') || '').trim();
        const isPublished = String(formData.get('isPublished') || 'false') === 'true';
        if (!slug) return;
        await setCoursePublishStatus(slug, !isPublished);
        // Revalidate by redirecting to the same page
        redirect('/admin/courses');
    }

    async function removeCourse(formData: FormData) {
        'use server';
        const slug = String(formData.get('slug') || '').trim();
        if (!slug) return;
        await deleteCourse(slug);
        redirect('/admin/courses');
    }

    return (
        <div className="min-h-full gradient-bg-admin-page">
            <div className="w-full px-6 lg:px-8 py-6 lg:py-8 space-y-8">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                    <div>
                        <h1 className="text-3xl lg:text-4xl font-bold text-gray-900 mb-2">
                            Courses
                        </h1>
                        <p className="text-base text-gray-600">
                            Create, publish, and manage courses
                        </p>
                    </div>
                    <div className="flex gap-3">
                        <button className="px-5 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-50 transition-all duration-200 font-medium shadow-sm hover:shadow">
                            Export CSV
                        </button>
                        <Link href="/admin/courses/new">
                            <button className="px-5 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-50 transition-all duration-200 font-medium shadow-sm hover:shadow">
                                New Course
                            </button>
                        </Link>
                        <Link href="/admin">
                            <button className="px-5 py-2.5 gradient-button-indigo text-white rounded-xl transition-all duration-200 font-medium shadow-lg hover:shadow-xl">
                                Back to Dashboard
                            </button>
                        </Link>
                    </div>
                </div>

                <CoursesTable
                    courses={courses as any[]}
                    togglePublish={togglePublish}
                    removeCourse={removeCourse}
                />
            </div>
        </div>
    );
}

