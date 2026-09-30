import { redirect } from 'next/navigation';
import { getCurrentUserWithRole } from '@/lib/auth';
import { createCourse } from '@/actions/course';
import Link from 'next/link';
import ThumbnailUploadForm from '@/components/admin/ThumbnailUploadForm';
import TitleSlugFields from '@/components/admin/TitleSlugFields';

export default async function NewCoursePage() {
    const user = await getCurrentUserWithRole();

    if (!user) {
        redirect('/sign-in');
    }

    if (user.role !== 'admin') {
        redirect('/dashboard');
    }

    async function handleCreate(formData: FormData) {
        'use server';
        const title = String(formData.get('title') || '').trim();
        const slug = String(formData.get('slug') || '').trim();
        const description = String(formData.get('description') || '').trim();
        const shortDescription = String(formData.get('shortDescription') || '').trim();
        const category = String(formData.get('category') || '').trim();
        const difficulty = String(formData.get('difficulty') || 'beginner') as any;
        const language = String(formData.get('language') || 'en');
        const priceRaw = String(formData.get('price') || '').trim();
        const thumbnailBase64 = String(formData.get('thumbnailBase64') || '').trim();
        const isFree = formData.get('isFree') === 'on';
        const isPublished = formData.get('isPublished') === 'on';
        const isFeatured = formData.get('isFeatured') === 'on';
        const tags = String(formData.get('tags') || '')
            .split(',')
            .map(t => t.trim())
            .filter(Boolean);

        if (!title || !slug || !description || !category) {
            return;
        }

        const price = priceRaw ? Number(priceRaw) : undefined;

        // Upload thumbnail if base64 present
        let thumbnailPublicId: string | undefined;
        let thumbnailUrl: string | undefined;
        if (thumbnailBase64) {
            const { uploadThumbnailBase64 } = await import('@/actions/course');
            const uploaded = await uploadThumbnailBase64(thumbnailBase64);
            if (uploaded.success) {
                thumbnailPublicId = (uploaded as any).public_id;
                thumbnailUrl = (uploaded as any).url;
            }
        }

        const res = await createCourse({
            title,
            slug,
            description,
            shortDescription: shortDescription || undefined,
            thumbnailPublicId,
            thumbnailUrl,
            category,
            tags,
            difficulty,
            language,
            price: isFree ? 0 : price,
            isFree,
            isPublished,
            isFeatured,
        });

        if (res.success) {
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
                            New Course
                        </h1>
                        <p className="text-base text-gray-600">
                            Fill out the details to create a course
                        </p>
                    </div>
                    <Link href="/admin/courses">
                        <button className="px-5 py-2.5 gradient-button-indigo text-white rounded-xl transition-all duration-200 font-medium shadow-lg hover:shadow-xl">
                            Back to Courses
                        </button>
                    </Link>
                </div>

                <form action={handleCreate} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-6">
                    <div className="grid grid-cols-1 gap-6">
                        <TitleSlugFields />

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Short Description</label>
                            <input name="shortDescription" className="w-full border border-gray-200 rounded-lg px-3 py-2" />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                            <textarea name="description" required rows={5} className="w-full border border-gray-200 rounded-lg px-3 py-2" />
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                                <select name="category" required defaultValue="" className="w-full border border-gray-200 rounded-lg px-3 py-2 bg-white">
                                    <option value="" disabled>Select category</option>
                                    {categories.map(c => (
                                        <option key={c} value={c}>{c}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Tags (comma separated)</label>
                                <input name="tags" placeholder="acquisition, seller-financing" className="w-full border border-gray-200 rounded-lg px-3 py-2" />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Difficulty</label>
                                <select name="difficulty" className="w-full border border-gray-200 rounded-lg px-3 py-2">
                                    <option value="beginner">Beginner</option>
                                    <option value="intermediate">Intermediate</option>
                                    <option value="advanced">Advanced</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Language</label>
                                <input name="language" defaultValue="en" className="w-full border border-gray-200 rounded-lg px-3 py-2" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Price (USD)</label>
                                <input name="price" type="number" step="0.01" className="w-full border border-gray-200 rounded-lg px-3 py-2" />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <label className="inline-flex items-center gap-2">
                                <input type="checkbox" name="isFree" />
                                <span className="text-sm text-gray-700">Free</span>
                            </label>
                            <label className="inline-flex items-center gap-2">
                                <input type="checkbox" name="isPublished" />
                                <span className="text-sm text-gray-700">Published</span>
                            </label>
                            <label className="inline-flex items-center gap-2">
                                <input type="checkbox" name="isFeatured" />
                                <span className="text-sm text-gray-700">Featured</span>
                            </label>
                        </div>

                        <div className="space-y-3">
                            <label className="block text-sm font-medium text-gray-700">Thumbnail</label>
                            <ThumbnailUploadForm initialUrl={null} inputName="thumbnailBase64" />
                        </div>

                        {/* Meta fields removed: meta title/description derived from title/description elsewhere */}

                        <div className="flex justify-end">
                            <button type="submit" className="px-5 py-2.5 gradient-button-indigo text-white rounded-xl transition-all duration-200 font-medium shadow-lg hover:shadow-xl">
                                Create Course
                            </button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
}

