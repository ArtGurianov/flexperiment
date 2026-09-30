import { redirect } from 'next/navigation';
import { getCurrentUserWithRole } from '@/lib/auth';
import { getCourseAdmin } from '@/actions/course';
import Link from 'next/link';

type Props = {
    params: Promise<{ slug: string }>;
};

export default async function CourseModulesPage(props: Props) {
    const params = await props.params;
    const user = await getCurrentUserWithRole();

    if (!user) {
        redirect('/sign-in');
    }

    if (user.role !== 'admin') {
        redirect('/dashboard');
    }

    const res = await getCourseAdmin({ slug: params.slug });
    if (!res.success || !res.course) {
        redirect('/admin/courses');
    }
    const course = res.course as any;

    return (
        <div className="min-h-full gradient-bg-admin-page">
            <div className="w-full px-6 lg:px-8 py-6 lg:py-8 space-y-8">
                <div className="flex items-center justify-between gap-4">
                    <div>
                        <h1 className="text-3xl lg:text-4xl font-bold text-gray-900 mb-2">
                            Course Content
                        </h1>
                        <p className="text-base text-gray-600">
                            Manage modules and lessons for {course.title}
                        </p>
                    </div>
                    <div className="flex items-center gap-3">
                        <Link href={`/admin/courses/${params.slug}/edit`}>
                            <button className="px-5 py-2.5 gradient-button-indigo text-white rounded-xl transition-all duration-200 font-medium shadow-lg hover:shadow-xl">
                                Back to Edit
                            </button>
                        </Link>
                        <Link href="/admin/courses">
                            <button className="px-5 py-2.5 bg-white border border-gray-200 rounded-xl transition-all duration-200 font-medium text-gray-700 hover:bg-gray-50">
                                All Courses
                            </button>
                        </Link>
                    </div>
                </div>

                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <h2 className="text-xl font-bold text-gray-900">Modules & Lessons</h2>
                            <p className="text-sm text-gray-600 mt-1">
                                Create and organize your course structure
                            </p>
                        </div>
                        <Link href={`/admin/courses/${params.slug}/modules/new`}>
                            <button className="px-4 py-2 text-sm font-medium bg-white border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50">
                                Add Module
                            </button>
                        </Link>
                    </div>

                    <div className="space-y-3">
                        {(course.modules || []).length === 0 ? (
                            <div className="text-sm text-gray-600">No modules yet. Create the first one.</div>
                        ) : (
                            (course.modules || []).sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0)).map((m: any) => (
                                <div key={m._id} className="border border-gray-100 rounded-xl p-4">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <div className="font-medium text-gray-900">
                                                {m.title} <span className="text-gray-400 text-xs">#{m.order ?? 0}</span>
                                            </div>
                                            {m.description ? (
                                                <div className="text-sm text-gray-600">{m.description}</div>
                                            ) : null}
                                        </div>
                                        <Link href={`/admin/courses/${params.slug}/modules/${m._id}/lessons/new`}>
                                            <button className="px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50">
                                                Add Lesson
                                            </button>
                                        </Link>
                                    </div>
                                    <div className="mt-3">
                                        {(m.lessons || []).length === 0 ? (
                                            <div className="text-xs text-gray-500">No lessons yet</div>
                                        ) : (
                                            <ul className="space-y-1">
                                                {(m.lessons || []).sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0)).map((l: any) => (
                                                    <li key={l._id} className="flex items-center justify-between text-sm text-gray-700">
                                                        <span>
                                                            {l.title} <span className="text-gray-400 text-xs">#{l.order ?? 0}</span>
                                                        </span>
                                                        <span className="text-xs text-gray-500">{l.isFree ? 'Free' : ''}</span>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}


