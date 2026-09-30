'use server';
import connectDB from '@/lib/mongodb';
import Course, { ICourse } from '@/models/Course';
import UserProgress from '@/models/UserProgress';
import Subscription from '@/models/Subscription';
import { uploadBase64ImageToCloudinary } from '@/utils/cloudinary';

/**
 * Admin: Add a module to a course
 */
export async function addModuleToCourse(
  slug: string,
  data: {
    title: string;
    description?: string;
    order: number;
  }
) {
  try {
    await connectDB();
    const course = await Course.findOne({ slug: slug.toLowerCase() });
    if (!course) {
      return { success: false, error: 'Course not found' };
    }
    course.modules.push({
      title: data.title,
      description: data.description,
      order: data.order,
      lessons: [],
    } as any);
    await course.save();
    return { success: true, course: JSON.parse(JSON.stringify(course)) };
  } catch (error: any) {
    console.error('Error adding module:', error);
    return { success: false, error: error?.message || 'Failed to add module' };
  }
}

/**
 * Admin: Add a lesson to a module within a course
 */
export async function addLessonToModule(
  slug: string,
  moduleId: string,
  data: {
    title: string;
    description?: string;
    videoUrl?: string;
    videoDuration?: number;
    order: number;
    isFree?: boolean;
  }
) {
  try {
    await connectDB();
    const course = await Course.findOne({ slug: slug.toLowerCase() });
    if (!course) {
      return { success: false, error: 'Course not found' };
    }
    const module = course.modules.find((m: any) => m._id.toString() === moduleId);
    if (!module) {
      return { success: false, error: 'Module not found' };
    }
    (module as any).lessons.push({
      title: data.title,
      description: data.description,
      videoUrl: data.videoUrl,
      videoDuration: data.videoDuration,
      order: data.order,
      isFree: data.isFree ?? false,
    });
    // Mark modified subdocument path
    (module as any).markModified?.('lessons');
    await course.save();
    return { success: true, course: JSON.parse(JSON.stringify(course)) };
  } catch (error: any) {
    console.error('Error adding lesson:', error);
    return { success: false, error: error?.message || 'Failed to add lesson' };
  }
}

/**
 * Admin: Create a new course
 */
export async function createCourse(data: {
  title: string;
  slug: string;
  description: string;
  shortDescription?: string;
  // Thumbnail (Cloudinary)
  thumbnail?: { public_id: string; url: string } | string | null;
  thumbnailPublicId?: string;
  thumbnailUrl?: string;
  category: string;
  tags?: string[];
  difficulty?: 'beginner' | 'intermediate' | 'advanced';
  language?: string;
  price?: number;
  currency?: string;
  isFree?: boolean;
  isPublished?: boolean;
  isFeatured?: boolean;
  metaTitle?: string;
  metaDescription?: string;
}) {
  try {
    await connectDB();
    const payload: Partial<ICourse> = {
      title: data.title,
      slug: data.slug.toLowerCase(),
      description: data.description,
      shortDescription: data.shortDescription,
      thumbnail: data.thumbnail
        ? (data.thumbnail as any)
        : data.thumbnailPublicId && data.thumbnailUrl
          ? { public_id: data.thumbnailPublicId, url: data.thumbnailUrl }
          : undefined,
      category: data.category,
      tags: data.tags,
      difficulty: data.difficulty || 'beginner',
      language: data.language || 'en',
      price: data.price,
      currency: data.currency || 'USD',
      isFree: data.isFree ?? false,
      isPublished: data.isPublished ?? false,
      isFeatured: data.isFeatured ?? false,
      metaTitle: data.metaTitle,
      metaDescription: data.metaDescription,
      enrolledCount: 0,
      completedCount: 0,
    } as any;
    const created = await Course.create(payload);
    return { success: true, course: JSON.parse(JSON.stringify(created)) };
  } catch (error: any) {
    console.error('Error creating course:', error);
    return { success: false, error: error?.message || 'Failed to create course' };
  }
}

/**
 * Admin: Update course thumbnail
 */
export async function updateCourseThumbnail(
  slug: string,
  thumbnail: { public_id: string; url: string } | null
) {
  try {
    await connectDB();
    const updated = await Course.findOneAndUpdate(
      { slug: slug.toLowerCase() },
      { thumbnail },
      { new: true }
    );
    if (!updated) {
      return { success: false, error: 'Course not found' };
    }
    return { success: true, course: JSON.parse(JSON.stringify(updated)) };
  } catch (error: any) {
    console.error('Error updating thumbnail:', error);
    return { success: false, error: error?.message || 'Failed to update thumbnail' };
  }
}

/**
 * Admin: Remove course thumbnail
 */
export async function removeCourseThumbnail(slug: string) {
  try {
    await connectDB();
    const updated = await Course.findOneAndUpdate(
      { slug: slug.toLowerCase() },
      { thumbnail: null },
      { new: true }
    );
    if (!updated) {
      return { success: false, error: 'Course not found' };
    }
    return { success: true, course: JSON.parse(JSON.stringify(updated)) };
  } catch (error: any) {
    console.error('Error removing thumbnail:', error);
    return { success: false, error: error?.message || 'Failed to remove thumbnail' };
  }
}

/**
 * Admin: Upload thumbnail from base64 and return { public_id, url }
 */
export async function uploadThumbnailBase64(imageBase64: string) {
  'use server';
  try {
    const result = await uploadBase64ImageToCloudinary(imageBase64);
    return { success: true, ...result };
  } catch (error: any) {
    console.error('Error uploading thumbnail:', error);
    return { success: false, error: error?.message || 'Failed to upload thumbnail' };
  }
}

/**
 * Admin: Replace course thumbnail from base64
 */
export async function replaceCourseThumbnailFromBase64(slug: string, imageBase64: string) {
  'use server';
  try {
    const uploaded = await uploadBase64ImageToCloudinary(imageBase64);
    const updated = await updateCourseThumbnail(slug, uploaded);
    return updated;
  } catch (error: any) {
    console.error('Error replacing course thumbnail:', error);
    return { success: false, error: error?.message || 'Failed to replace thumbnail' };
  }
}

/**
 * Admin: Get a course by id or slug
 */
export async function getCourseAdmin(identifier: { id?: string; slug?: string }) {
  try {
    await connectDB();
    const query = identifier.id ? { _id: identifier.id } : { slug: identifier.slug?.toLowerCase() };
    const course = await Course.findOne(query).lean();
    if (!course) {
      return { success: false, error: 'Course not found' };
    }
    return { success: true, course: JSON.parse(JSON.stringify(course)) };
  } catch (error) {
    console.error('Error fetching course (admin):', error);
    return { success: false, error: 'Failed to fetch course' };
  }
}

/**
 * Admin: Update a course
 */
export async function updateCourse(
  identifier: { id?: string; slug?: string },
  data: Partial<{
    title: string;
    slug: string;
    description: string;
    shortDescription?: string;
    category: string;
    tags?: string[];
    difficulty: 'beginner' | 'intermediate' | 'advanced';
    language: string;
    price?: number;
    currency?: string;
    isFree?: boolean;
    isPublished?: boolean;
    isFeatured?: boolean;
    metaTitle?: string;
    metaDescription?: string;
  }>
) {
  try {
    await connectDB();
    const query = identifier.id ? { _id: identifier.id } : { slug: identifier.slug?.toLowerCase() };
    const update: any = { ...data };
    if (update.slug) update.slug = update.slug.toLowerCase();
    const updated = await Course.findOneAndUpdate(query, update, { new: true });
    if (!updated) {
      return { success: false, error: 'Course not found' };
    }
    return { success: true, course: JSON.parse(JSON.stringify(updated)) };
  } catch (error: any) {
    console.error('Error updating course:', error);
    return { success: false, error: error?.message || 'Failed to update course' };
  }
}

/**
 * Get all published courses
 */
export async function getPublishedCourses() {
  try {
    await connectDB();
    const courses = await Course.find({ isPublished: true })
      .sort({ createdAt: -1 })
      .lean();
    return { success: true, courses: JSON.parse(JSON.stringify(courses)) };
  } catch (error) {
    console.error('Error fetching courses:', error);
    return { success: false, error: 'Failed to fetch courses' };
  }
}

/**
 * Get featured courses
 */
export async function getFeaturedCourses() {
  try {
    await connectDB();
    const courses = await Course.find({ isPublished: true, isFeatured: true })
      .sort({ rating: -1 })
      .limit(6)
      .lean();
    return { success: true, courses: JSON.parse(JSON.stringify(courses)) };
  } catch (error) {
    console.error('Error fetching featured courses:', error);
    return { success: false, error: 'Failed to fetch featured courses' };
  }
}

/**
 * Get a single course by slug
 */
export async function getCourseBySlug(slug: string) {
  try {
    await connectDB();
    const course = await Course.findOne({ slug, isPublished: true }).lean();
    
    if (!course) {
      return { success: false, error: 'Course not found' };
    }
    
    return { success: true, course: JSON.parse(JSON.stringify(course)) };
  } catch (error) {
    console.error('Error fetching course:', error);
    return { success: false, error: 'Failed to fetch course' };
  }
}

/**
 * Get courses by category
 */
export async function getCoursesByCategory(category: string) {
  try {
    await connectDB();
    const courses = await Course.find({ 
      category, 
      isPublished: true 
    })
      .sort({ createdAt: -1 })
      .lean();
    return { success: true, courses: JSON.parse(JSON.stringify(courses)) };
  } catch (error) {
    console.error('Error fetching courses by category:', error);
    return { success: false, error: 'Failed to fetch courses' };
  }
}

/**
 * Check if user has completed subscription ($99 one-time payment = lifetime access)
 */
export async function checkSubscription(clerkId: string) {
  try {
    await connectDB();
    
    // Simply check if status is 'completed' - that's the ONLY source of truth
    const subscription = await Subscription.findOne({ 
      clerkId,
      status: 'completed'
    }).lean();
    
    return {
      success: true,
      isSubscribed: !!subscription, // Boolean: does a completed subscription exist?
      subscription: subscription ? JSON.parse(JSON.stringify(subscription)) : null
    };
  } catch (error) {
    console.error('Error checking subscription:', error);
    return { success: false, isSubscribed: false, subscription: null };
  }
}

/**
 * Get user's courses (ALL courses if subscribed, only enrolled if not)
 */
export async function getUserCourses(clerkId: string) {
  try {
    await connectDB();
    
    // Check if user has completed subscription (status: 'completed')
    const subCheck = await checkSubscription(clerkId);
    
    if (subCheck.isSubscribed) {
      // USER HAS SUBSCRIPTION - Show ALL published courses
      const allCourses = await Course.find({ isPublished: true })
        .sort({ createdAt: -1 })
        .lean();
      
      // Get existing progress for courses
      const progressRecords = await UserProgress.find({ clerkId }).lean();
      
      // For each course, attach progress if it exists, otherwise create it
      const coursesWithProgress = await Promise.all(
        allCourses.map(async (course) => {
          let progress = progressRecords.find(
            p => p.courseId === course._id.toString()
          );
          
          // Auto-create progress tracking if doesn't exist
          if (!progress) {
            const newProgress = await createProgressForCourse(clerkId, course._id.toString());
            progress = (newProgress as any) ?? undefined;
          }
          
          // Count actual completed lessons
          let completedLessonsCount = 0;
          if (progress?.modules) {
            progress.modules.forEach((module: any) => {
              if (module.lessons) {
                completedLessonsCount += module.lessons.filter((l: any) => l.completed).length;
              }
            });
          }
          
          return {
            ...course,
            progress: progress?.overallProgress || 0,
            completedLessonsCount, // Add actual count
            lastAccessed: progress?.lastAccessedAt,
            isCompleted: progress?.isCompleted || false,
          };
        })
      );
      
      return { 
        success: true, 
        courses: JSON.parse(JSON.stringify(coursesWithProgress)),
        subscription: true
      };
    } else {
      // NO SUBSCRIPTION - Show only manually enrolled courses (legacy behavior)
      const progressRecords = await UserProgress.find({ clerkId })
        .sort({ lastAccessedAt: -1 })
        .lean();
      
      if (progressRecords.length === 0) {
        return { success: true, courses: [], subscription: false };
      }
      
      const courseIds = progressRecords.map(p => p.courseId);
      const courses = await Course.find({ 
        _id: { $in: courseIds } 
      }).lean();
      
      const coursesWithProgress = courses.map(course => {
        const progress = progressRecords.find(
          p => p.courseId === course._id.toString()
        );
        
        // Count actual completed lessons
        let completedLessonsCount = 0;
        if (progress?.modules) {
          progress.modules.forEach((module: any) => {
            if (module.lessons) {
              completedLessonsCount += module.lessons.filter((l: any) => l.completed).length;
            }
          });
        }
        
        return {
          ...course,
          progress: progress?.overallProgress || 0,
          completedLessonsCount, // Add actual count
          lastAccessed: progress?.lastAccessedAt,
          isCompleted: progress?.isCompleted || false,
        };
      });
      
      return { 
        success: true, 
        courses: JSON.parse(JSON.stringify(coursesWithProgress)),
        subscription: false
      };
    }
  } catch (error) {
    console.error('Error fetching user courses:', error);
    return { success: false, error: 'Failed to fetch user courses', subscription: false };
  }
}

/**
 * Helper: Create progress tracking for a course
 */
async function createProgressForCourse(clerkId: string, courseId: string) {
  try {
    const course = await Course.findById(courseId);
    if (!course) return null;
    
    // Create progress structure
    const modules = course.modules.map((module) => ({
      moduleId: module._id?.toString() || '',
      completed: false,
      progress: 0,
      lessons: module.lessons.map((lesson) => ({
        lessonId: lesson._id?.toString() || '',
        completed: false,
        lastWatchedPosition: 0,
        timeSpent: 0,
      })),
    }));
    
    const progress = await UserProgress.create({
      userId: clerkId,
      clerkId,
      courseId,
      modules,
      overallProgress: 0,
      enrolledAt: new Date(),
      lastAccessedAt: new Date(),
    });
    
    // Return as lean object to match the type
    return progress.toObject();
  } catch (error) {
    console.error('Error creating progress:', error);
    return null;
  }
}

/**
 * Update lesson completion status and recalculate progress
 */
export async function updateLessonCompletion(
  clerkId: string,
  courseId: string,
  lessonId: string,
  completed: boolean
) {
  try {
    await connectDB();
    
    const progress = await UserProgress.findOne({ clerkId, courseId });
    if (!progress) {
      return { success: false, error: 'Progress record not found' };
    }
    
    // Find and update the lesson
    let lessonFound = false;
    for (const module of progress.modules) {
      const lesson = module.lessons.find((l: any) => l.lessonId === lessonId);
      if (lesson) {
        lesson.completed = completed;
        lessonFound = true;
        break;
      }
    }
    
    if (!lessonFound) {
      return { success: false, error: 'Lesson not found' };
    }
    
    // Recalculate progress
    const totalLessons = progress.modules.reduce(
      (sum: number, m: any) => sum + m.lessons.length,
      0
    );
    const completedLessons = progress.modules.reduce(
      (sum: number, m: any) => 
        sum + m.lessons.filter((l: any) => l.completed).length,
      0
    );
    
    progress.overallProgress = totalLessons > 0 
      ? Math.round((completedLessons / totalLessons) * 100)
      : 0;
    
    // Update module progress
    progress.modules.forEach((module: any) => {
      const moduleTotal = module.lessons.length;
      const moduleCompleted = module.lessons.filter((l: any) => l.completed).length;
      module.progress = moduleTotal > 0 
        ? Math.round((moduleCompleted / moduleTotal) * 100) 
        : 0;
      module.completed = module.progress === 100;
    });
    
    // Check if course is complete
    progress.isCompleted = progress.overallProgress === 100;
    if (progress.isCompleted && !progress.completedAt) {
      progress.completedAt = new Date();
    }
    
    progress.lastAccessedAt = new Date();
    await progress.save();
    
    return {
      success: true,
      progress: progress.overallProgress,
      isCompleted: progress.isCompleted,
    };
  } catch (error) {
    console.error('Error updating lesson completion:', error);
    return { success: false, error: 'Failed to update lesson completion' };
  }
}

/**
 * Get user progress for a specific course
 */
export async function getUserCourseProgress(clerkId: string, courseId: string) {
  try {
    await connectDB();
    
    const progress = await UserProgress.findOne({ clerkId, courseId }).lean();
    if (!progress) {
      return { success: false, error: 'Progress not found' };
    }
    
    return {
      success: true,
      progress: JSON.parse(JSON.stringify(progress)),
    };
  } catch (error) {
    console.error('Error fetching user progress:', error);
    return { success: false, error: 'Failed to fetch progress' };
  }
}

/**
 * Calculate user's learning streak (consecutive days)
 */
export async function getUserStreak(clerkId: string) {
  try {
    await connectDB();
    
    // Get all user progress records sorted by last access
    const progressRecords = await UserProgress.find({ clerkId })
      .sort({ lastAccessedAt: -1 })
      .lean();
    
    if (progressRecords.length === 0) {
      return { success: true, streak: 0, lastActive: null };
    }
    
    // Get all unique activity dates
    const activityDates = progressRecords
      .filter(p => p.lastAccessedAt)
      .map(p => {
        const date = new Date(p.lastAccessedAt);
        // Reset to start of day for comparison
        return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
      });
    
    // Remove duplicates and sort
    const uniqueDates = [...new Set(activityDates)].sort((a, b) => b - a);
    
    if (uniqueDates.length === 0) {
      return { success: true, streak: 0, lastActive: null };
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTime = today.getTime();
    const oneDayMs = 24 * 60 * 60 * 1000;
    
    // Check if user was active today or yesterday (streak still valid)
    const mostRecentActivity = uniqueDates[0];
    const daysSinceActivity = Math.floor((todayTime - mostRecentActivity) / oneDayMs);
    
    if (daysSinceActivity > 1) {
      // Streak broken (more than 1 day gap)
      return { success: true, streak: 0, lastActive: new Date(mostRecentActivity) };
    }
    
    // Calculate consecutive days
    let streak = 1;
    let currentDate = mostRecentActivity;
    
    for (let i = 1; i < uniqueDates.length; i++) {
      const prevDate = uniqueDates[i];
      const dayDiff = Math.floor((currentDate - prevDate) / oneDayMs);
      
      if (dayDiff === 1) {
        // Consecutive day
        streak++;
        currentDate = prevDate;
      } else {
        // Gap found, stop counting
        break;
      }
    }
    
    return {
      success: true,
      streak,
      lastActive: new Date(mostRecentActivity),
    };
  } catch (error) {
    console.error('Error calculating user streak:', error);
    return { success: false, streak: 0, lastActive: null };
  }
}

/**
 * Enroll user in a course
 */
export async function enrollInCourse(clerkId: string, courseId: string) {
  try {
    await connectDB();
    
    // Check if course exists
    const course = await Course.findById(courseId);
    if (!course) {
      return { success: false, error: 'Course not found' };
    }
    
    // Check if already enrolled
    const existingProgress = await UserProgress.findOne({ clerkId, courseId });
    if (existingProgress) {
      return { success: false, error: 'Already enrolled in this course' };
    }
    
    // Create progress tracking structure from course modules
    const modules = course.modules.map((module) => ({
      moduleId: module._id?.toString() || '',
      completed: false,
      progress: 0,
      lessons: module.lessons.map((lesson) => ({
        lessonId: lesson._id?.toString() || '',
        completed: false,
        lastWatchedPosition: 0,
        timeSpent: 0,
      })),
    }));
    
    // Create user progress
    const progress = await UserProgress.create({
      userId: clerkId, // You might want to use MongoDB user ID instead
      clerkId,
      courseId,
      modules,
      overallProgress: 0,
      enrolledAt: new Date(),
      lastAccessedAt: new Date(),
    });
    
    // Increment enrolled count on course
    await Course.findByIdAndUpdate(courseId, {
      $inc: { enrolledCount: 1 },
    });
    
    return { 
      success: true, 
      progress: JSON.parse(JSON.stringify(progress)) 
    };
  } catch (error) {
    console.error('Error enrolling in course:', error);
    return { success: false, error: 'Failed to enroll in course' };
  }
}

/**
 * Mark a lesson as completed
 */
export async function completeLesson(
  clerkId: string, 
  courseId: string, 
  moduleId: string, 
  lessonId: string
) {
  try {
    await connectDB();
    
    const progress = await UserProgress.findOne({ clerkId, courseId });
    
    if (!progress) {
      return { success: false, error: 'Not enrolled in this course' };
    }
    
    // Use the method we defined on the model
    progress.completeLesson(moduleId, lessonId);
    progress.updateLastAccessed();
    await progress.save();
    
    // If course is completed, increment completed count
    if (progress.isCompleted && progress.completedAt) {
      await Course.findByIdAndUpdate(courseId, {
        $inc: { completedCount: 1 },
      });
    }
    
    return { 
      success: true, 
      progress: JSON.parse(JSON.stringify(progress)) 
    };
  } catch (error) {
    console.error('Error completing lesson:', error);
    return { success: false, error: 'Failed to complete lesson' };
  }
}

/**
 * Activate subscription after successful Stripe payment
 * Call this from your Stripe webhook handler
 */
export async function activateSubscription(
  clerkId: string,
  stripePaymentIntentId: string,
  stripeCustomerId?: string
) {
  try {
    await connectDB();
    
    // Check if this payment was already processed (idempotency)
    const existingByPayment = await Subscription.findOne({ stripePaymentIntentId });
    if (existingByPayment) {
      return {
        success: true,
        subscription: JSON.parse(JSON.stringify(existingByPayment)),
        message: 'Subscription already activated',
        alreadyProcessed: true
      };
    }
    
    // Check if user already has a subscription
    let subscription = await Subscription.findOne({ clerkId });
    
    if (subscription) {
      // Update existing subscription (in case of reactivation)
      subscription.status = 'completed';
      subscription.activatedAt = new Date();
      subscription.stripePaymentIntentId = stripePaymentIntentId;
      if (stripeCustomerId) {
        subscription.stripeCustomerId = stripeCustomerId;
      }
      await subscription.save();
    } else {
      // Create new subscription
      subscription = await Subscription.create({
        userId: clerkId,
        clerkId,
        status: 'completed',
        amount: 99,
        currency: 'USD',
        stripePaymentIntentId,
        stripeCustomerId,
        purchaseDate: new Date(),
        activatedAt: new Date(),
      });
    }
    
    return {
      success: true,
      subscription: JSON.parse(JSON.stringify(subscription)),
      message: 'Subscription activated! You now have access to all courses.',
      alreadyProcessed: false
    };
  } catch (error) {
    console.error('Error activating subscription:', error);
    return { success: false, error: 'Failed to activate subscription' };
  }
}

/**
 * Get pending subscriptions for admin review (payments that succeeded but need manual activation)
 */
export async function getPendingSubscriptions() {
  try {
    await connectDB();
    
    const pendingSubscriptions = await Subscription.find({ status: 'pending' })
      .sort({ purchaseDate: -1 })
      .lean();
    
    return {
      success: true,
      subscriptions: JSON.parse(JSON.stringify(pendingSubscriptions)),
    };
  } catch (error) {
    console.error('Error fetching pending subscriptions:', error);
    return { success: false, error: 'Failed to fetch pending subscriptions' };
  }
}

/**
 * Manually activate a pending subscription (Admin only)
 */
export async function manuallyActivateSubscription(subscriptionId: string) {
  try {
    await connectDB();
    
    const subscription = await Subscription.findById(subscriptionId);
    
    if (!subscription) {
      return { success: false, error: 'Subscription not found' };
    }
    
    if (subscription.status === 'completed') {
      return { success: false, error: 'Subscription already activated' };
    }
    
    // Activate the subscription
    subscription.status = 'completed';
    subscription.activatedAt = new Date();
    await subscription.save();
    
    return {
      success: true,
      subscription: JSON.parse(JSON.stringify(subscription)),
      message: 'Subscription manually activated successfully',
    };
  } catch (error) {
    console.error('Error manually activating subscription:', error);
    return { success: false, error: 'Failed to activate subscription' };
  }
}

/**
 * Get course statistics (admin)
 */
export async function getCourseStats() {
  try {
    await connectDB();
    
    const totalCourses = await Course.countDocuments();
    const publishedCourses = await Course.countDocuments({ isPublished: true });
    const totalEnrollments = await UserProgress.countDocuments();
    const completedCourses = await UserProgress.countDocuments({ isCompleted: true });
    
    // Subscription stats
    const totalSubscriptions = await Subscription.countDocuments({ status: 'completed' });
    const pendingSubscriptions = await Subscription.countDocuments({ status: 'pending' });
    const totalRevenue = await Subscription.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    
    const topCourses = await Course.find({ isPublished: true })
      .sort({ enrolledCount: -1 })
      .limit(5)
      .select('title enrolledCount rating')
      .lean();
    
    return {
      success: true,
      stats: {
        totalCourses,
        publishedCourses,
        totalEnrollments,
        completedCourses,
        completionRate: totalEnrollments > 0 
          ? ((completedCourses / totalEnrollments) * 100).toFixed(1) 
          : 0,
        totalSubscriptions,
        pendingSubscriptions,
        totalRevenue: totalRevenue[0]?.total || 0,
        topCourses: JSON.parse(JSON.stringify(topCourses)),
      },
    };
  } catch (error) {
    console.error('Error fetching course stats:', error);
    return { success: false, error: 'Failed to fetch course statistics' };
  }
}

/**
 * Admin: Get all courses (published and unpublished)
 */
export async function getAllCoursesAdmin() {
  try {
    await connectDB();
    const courses = await Course.find({})
      .sort({ createdAt: -1 })
      .lean();
    return { success: true, courses: JSON.parse(JSON.stringify(courses)) };
  } catch (error) {
    console.error('Error fetching all courses (admin):', error);
    return { success: false, error: 'Failed to fetch courses' };
  }
}

/**
 * Admin: Set publish status
 */
export async function setCoursePublishStatus(slug: string, isPublished: boolean) {
  try {
    await connectDB();
    const updated = await Course.findOneAndUpdate(
      { slug: slug.toLowerCase() },
      { isPublished, publishedAt: isPublished ? new Date() : undefined },
      { new: true }
    );
    if (!updated) {
      return { success: false, error: 'Course not found' };
    }
    return { success: true, course: JSON.parse(JSON.stringify(updated)) };
  } catch (error) {
    console.error('Error updating publish status:', error);
    return { success: false, error: 'Failed to update publish status' };
  }
}

/**
 * Admin: Delete a course
 */
export async function deleteCourse(slug: string) {
  try {
    await connectDB();
    const deleted = await Course.findOneAndDelete({ slug: slug.toLowerCase() });
    if (!deleted) {
      return { success: false, error: 'Course not found' };
    }
    return { success: true };
  } catch (error) {
    console.error('Error deleting course:', error);
    return { success: false, error: 'Failed to delete course' };
  }
}

