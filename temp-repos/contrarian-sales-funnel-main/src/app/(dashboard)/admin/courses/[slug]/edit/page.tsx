import { redirect } from 'next/navigation';
import { getCurrentUserWithRole } from '@/lib/auth';
import { getCourseAdmin, updateCourse } from '@/actions/course';
import Link from 'next/link';
import ThumbnailUploadForm from '@/components/admin/ThumbnailUploadForm';

type Props = {
    params: Promise<{ slug: string }>;
};

export default async function EditCoursePage(props: Props) {
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

    async function handleUpdate(formData: FormData) {
        'use server';
        const title = String(formData.get('title') || '').trim();
        const slug = String(formData.get('slug') || '').trim();
        const description = String(formData.get('description') || '').trim();
        const shortDescription = String(formData.get('shortDescription') || '').trim();
        const category = String(formData.get('category') || '').trim();
        const difficulty = String(formData.get('difficulty') || 'beginner') as any;
        const language = String(formData.get('language') || 'en');
        const priceRaw = String(formData.get('price') || '').trim();
        const isFree = formData.get('isFree') === 'on';
        const isPublished = formData.get('isPublished') === 'on';
        const isFeatured = formData.get('isFeatured') === 'on';
        const tags = String(formData.get('tags') || '')
            .split(',')
            .map(t => t.trim())
            .filter(Boolean);
        const thumbnailBase64 = String(formData.get('thumbnailBase64') || '').trim();

        const price = priceRaw ? Number(priceRaw) : undefined;

        const payload: any = {
            title,
            slug,
            description,
            shortDescription: shortDescription || undefined,
            category,
            tags,
            difficulty,
            language,
            price: isFree ? 0 : price,
            isFree,
            isPublished,
            isFeatured,
        };

        // Remove empty fields to avoid overwriting with blank strings
        Object.keys(payload).forEach((k) => {
            if (payload[k] === '' || payload[k] === undefined) delete payload[k];
        });

        // Handle thumbnail changes before updating the course fields
        if (thumbnailBase64) {
            const { replaceCourseThumbnailFromBase64 } = await import('@/actions/course');
            await replaceCourseThumbnailFromBase64(params.slug, thumbnailBase64);
        }

        const result = await updateCourse({ slug: params.slug }, payload);
        if (result.success) {
            redirect('/admin/courses');
        }
    }

    const categories = ['Acquisition', 'Seller Financing', 'Operations', 'Marketing', 'Finance', 'Other'];

    return (
        <div className="min-h-full gradient-bg-admin-page">
            <div className="w-full px-6 lg:px-8 py-6 lg:py-8 space-y-8">
                <div className="flex items-center justify-between gap-4">
                    <div>
                        <h1 className="text-3xl lg:text-4xl font-bold text-gray-900 mb-2">
                            Edit Course
                        </h1>
                        <p className="text-base text-gray-600">
                            Update details for {course.title}
                        </p>
                    </div>
                    <Link href="/admin/courses">
                        <button className="px-5 py-2.5 gradient-button-indigo text-white rounded-xl transition-all duration-200 font-medium shadow-lg hover:shadow-xl">
                            Back to Courses
                        </button>
                    </Link>
                </div>

                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                    <div className="flex items-center justify-between">
                        <div>
                            <h2 className="text-xl font-bold text-gray-900">Course Content</h2>
                            <p className="text-sm text-gray-600 mt-1">Manage modules and lessons on a dedicated page</p>
                        </div>
                        <Link href={`/admin/courses/${params.slug}/modules`}>
                            <button className="px-4 py-2 text-sm font-medium bg-white border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50">
                                Open Content Manager
                            </button>
                        </Link>
                    </div>
                </div>

                <form action={handleUpdate} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-6">
                    <div className="grid grid-cols-1 gap-6">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                                <input name="title" defaultValue={course.title} className="w-full border border-gray-200 rounded-lg px-3 py-2" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Slug</label>
                                <input name="slug" defaultValue={course.slug} className="w-full border border-gray-200 rounded-lg px-3 py-2 lowercase" />
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Short Description</label>
                            <input name="shortDescription" defaultValue={course.shortDescription || ''} className="w-full border border-gray-200 rounded-lg px-3 py-2" />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                            <textarea name="description" rows={5} defaultValue={course.description} className="w-full border border-gray-200 rounded-lg px-3 py-2" />
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                                <select name="category" defaultValue={categories.includes(course.category) ? course.category : course.category || categories[0]} className="w-full border border-gray-200 rounded-lg px-3 py-2 bg-white">
                                    {(!categories.includes(course.category) && course.category) ? (
                                        <option value={course.category}>{course.category}</option>
                                    ) : null}
                                    {categories.map(c => (
                                        <option key={c} value={c}>{c}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Tags (comma separated)</label>
                                <input name="tags" defaultValue={(course.tags || []).join(', ')} className="w-full border border-gray-200 rounded-lg px-3 py-2" />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Difficulty</label>
                                <select name="difficulty" defaultValue={course.difficulty} className="w-full border border-gray-200 rounded-lg px-3 py-2">
                                    <option value="beginner">Beginner</option>
                                    <option value="intermediate">Intermediate</option>
                                    <option value="advanced">Advanced</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Language</label>
                                <input name="language" defaultValue={course.language || 'en'} className="w-full border border-gray-200 rounded-lg px-3 py-2" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Price (USD)</label>
                                <input name="price" type="number" step="0.01" defaultValue={course.price ?? ''} className="w-full border border-gray-200 rounded-lg px-3 py-2" />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <label className="inline-flex items-center gap-2">
                                <input type="checkbox" name="isFree" defaultChecked={course.isFree} />
                                <span className="text-sm text-gray-700">Free</span>
                            </label>
                            <label className="inline-flex items-center gap-2">
                                <input type="checkbox" name="isPublished" defaultChecked={course.isPublished} />
                                <span className="text-sm text-gray-700">Published</span>
                            </label>
                            <label className="inline-flex items-center gap-2">
                                <input type="checkbox" name="isFeatured" defaultChecked={course.isFeatured} />
                                <span className="text-sm text-gray-700">Featured</span>
                            </label>
                        </div>

                        <div className="space-y-3">
                            <label className="block text-sm font-medium text-gray-700">Thumbnail</label>
                            <ThumbnailUploadForm
                                initialUrl={
                                    course.thumbnail?.url || null
                                }
                                inputName="thumbnailBase64"
                            />
                        </div>

                        <div className="flex justify-end">
                            <button type="submit" className="px-5 py-2.5 gradient-button-indigo text-white rounded-xl transition-all duration-200 font-medium shadow-lg hover:shadow-xl">
                                Save Changes
                            </button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
}

