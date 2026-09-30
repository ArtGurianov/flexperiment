import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUserWithRole } from '@/lib/auth';
import { getUserCourses, getPublishedCourses, getUserStreak } from '@/actions/course';
import { syncUserToDatabase } from '@/actions/user';

// Helper function to format duration from minutes to "Xh Ym" string
function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

export default async function StudentDashboardPage() {
  // Ensure the Clerk user is synced to our MongoDB (fallback if webhooks aren't configured locally)
  await syncUserToDatabase();
  const user = await getCurrentUserWithRole();

  if (!user) {
    redirect('/sign-in');
  }

  // Fetch user's courses with progress from database
  const coursesResult = await getUserCourses(user.id);
  
  // Fetch user's learning streak
  const streakResult = await getUserStreak(user.id);
  const dayStreak = streakResult.success ? streakResult.streak : 0;
  
  // Transform the data to match the UI structure
  const courses = coursesResult.success && coursesResult.courses
    ? coursesResult.courses.map((course: any) => {
        // Calculate duration from modules if totalDuration is not set
        let totalMinutes = course.totalDuration || 0;
        if (!totalMinutes && course.modules) {
          let totalSeconds = 0;
          course.modules.forEach((module: any) => {
            module.lessons?.forEach((lesson: any) => {
              totalSeconds += lesson.videoDuration || 0;
            });
          });
          totalMinutes = Math.ceil(totalSeconds / 60);
        }
        
        return {
          id: course._id,
          title: course.title,
          progress: course.progress || 0,
          thumbnail: course.thumbnail || '/images/codie-sanchez-500.webp',
          lessons: course.totalLessons || 0,
          duration: totalMinutes > 0 ? formatDuration(totalMinutes) : '0m',
          durationMinutes: totalMinutes, // Store raw minutes for calculation
          category: course.category,
          slug: course.slug,
          description: course.description,
          instructor: course.instructor,
          completedLessonsCount: course.completedLessonsCount || 0,
        };
      })
    : [];

  // Calculate stats from real data
  const activeCourses = courses.length;
  
  // Sum actual completed lessons from database
  const completedLessons = courses.reduce((sum: number, c: typeof courses[0]) => {
    return sum + (c.completedLessonsCount || 0);
  }, 0);
  
  // Calculate total available content (all enrolled courses)
  const totalLearningTime = courses.reduce((sum: number, c: typeof courses[0]) => {
    return sum + (c.durationMinutes || 0);
  }, 0);
  
  const learningTimeFormatted = totalLearningTime > 0 
    ? formatDuration(totalLearningTime) 
    : '0h';
  
  // Generate real recent activity from course progress
  const recentActivity = courses
    .filter((c: typeof courses[0]) => c.progress > 0)
    .sort((a: typeof courses[0], b: typeof courses[0]) => {
      // Sort by progress (most recent activity first)
      return b.progress - a.progress;
    })
    .slice(0, 4)
    .map((course: typeof courses[0]) => {
      if (course.progress === 100) {
        return {
          type: 'completed',
          title: `Completed "${course.title}"`,
          time: 'Recently',
        };
      } else if (course.progress > 50) {
        return {
          type: 'milestone',
          title: `${course.progress}% complete in "${course.title}"`,
          time: 'In progress',
        };
      } else if (course.progress > 0) {
        return {
          type: 'started',
          title: `Started "${course.title}"`,
          time: 'In progress',
        };
      }
      return {
        type: 'started',
        title: `Enrolled in "${course.title}"`,
        time: 'Recently',
      };
    });

  return (
    <div className="min-h-full gradient-bg-page">
      <div className="max-w-7xl mx-auto p-6 lg:p-8 space-y-8">
        {/* Welcome Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl lg:text-4xl font-bold text-gray-900 mb-2">
              Welcome back, {user.firstName}! 👋
            </h1>
            <p className="text-base text-gray-600">
              Continue your learning journey and achieve your goals
            </p>
          </div>
          <div className="flex gap-3">
            <button className="px-5 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-50 transition-all duration-200 font-medium shadow-sm hover:shadow">
              Browse Courses
            </button>
            <button className="px-5 py-2.5 gradient-button text-white rounded-xl transition-all duration-200 font-medium shadow-lg hover:shadow-xl">
              Continue Learning
            </button>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <div className="relative overflow-hidden gradient-stat-blue rounded-2xl p-6 text-white shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105">
            <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-16 -mt-16"></div>
            <div className="relative">
              <div className="flex items-center justify-between mb-3">
                <div className="bg-white/20 p-3 rounded-xl backdrop-blur-sm">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                  </svg>
                </div>
                <span className="text-2xl font-bold">{activeCourses}</span>
              </div>
              <p className="text-sm font-medium text-blue-100">Active Courses</p>
              <p className="text-xs text-blue-200 mt-1">{activeCourses > 0 ? 'In progress' : 'Get started'}</p>
            </div>
          </div>

          <div className="relative overflow-hidden gradient-stat-purple rounded-2xl p-6 text-white shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105">
            <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-16 -mt-16"></div>
            <div className="relative">
              <div className="flex items-center justify-between mb-3">
                <div className="bg-white/20 p-3 rounded-xl backdrop-blur-sm">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <span className="text-2xl font-bold">{completedLessons}</span>
              </div>
              <p className="text-sm font-medium text-purple-100">Lessons Complete</p>
              <p className="text-xs text-purple-200 mt-1">Keep learning!</p>
            </div>
          </div>

          <div className="relative overflow-hidden gradient-stat-amber rounded-2xl p-6 text-white shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105">
            <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-16 -mt-16"></div>
            <div className="relative">
              <div className="flex items-center justify-between mb-3">
                <div className="bg-white/20 p-3 rounded-xl backdrop-blur-sm">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <span className="text-2xl font-bold">{learningTimeFormatted}</span>
              </div>
              <p className="text-sm font-medium text-amber-100">Total Content</p>
              <p className="text-xs text-amber-200 mt-1">Available to you</p>
            </div>
          </div>

          <div className="relative overflow-hidden gradient-stat-emerald rounded-2xl p-6 text-white shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105">
            <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-16 -mt-16"></div>
            <div className="relative">
              <div className="flex items-center justify-between mb-3">
                <div className="bg-white/20 p-3 rounded-xl backdrop-blur-sm">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <span className="text-2xl font-bold">{dayStreak}</span>
              </div>
              <p className="text-sm font-medium text-emerald-100">Day Streak</p>
              <p className="text-xs text-emerald-200 mt-1">
                {dayStreak === 0 ? 'Start learning today!' : dayStreak === 1 ? 'Great start!' : 'Keep it up!'}
              </p>
            </div>
          </div>
        </div>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* My Courses - Takes 2 columns */}
          <div className="lg:col-span-2 space-y-6">
            {/* Continue Learning Section */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="p-6 border-b border-gray-100">
                <h2 className="text-xl font-bold text-gray-900">Continue Learning</h2>
                <p className="text-sm text-gray-600 mt-1">Pick up where you left off</p>
              </div>
              <div className="p-6 space-y-4">
                {courses.length === 0 ? (
                  <div className="text-center py-12">
                    <div className="text-6xl mb-4">📚</div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-2">No courses yet</h3>
                    <p className="text-gray-600 mb-6">Start your learning journey by enrolling in a course</p>
                    <button className="px-6 py-3 gradient-button text-white rounded-xl font-medium shadow-lg hover:shadow-xl transition-all">
                      Browse Courses
                    </button>
                  </div>
                ) : (
                  courses.map((course: typeof courses[0]) => (
                  <Link
                    key={course.id}
                    href={`/courses/${course.slug}`}
                    className="group flex flex-col sm:flex-row gap-4 p-4 gradient-card-subtle rounded-xl border border-gray-100 hover:border-blue-200 hover:shadow-md transition-all duration-300 cursor-pointer"
                  >
                    <div className="relative w-full sm:w-32 h-32 sm:h-24 gradient-course-thumb rounded-lg overflow-hidden shrink-0">
                      <div className="absolute inset-0 flex items-center justify-center text-4xl">
                        📚
                      </div>
                      <div className="absolute top-2 right-2 bg-white/90 backdrop-blur-sm px-2 py-1 rounded-full text-xs font-semibold text-gray-700">
                        {course.category}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <h3 className="font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
                          {course.title}
                        </h3>
                        <svg className="w-5 h-5 text-gray-400 group-hover:text-blue-600 group-hover:translate-x-1 transition-all shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-600 mb-3">
                        <span className="flex items-center gap-1">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                          </svg>
                          {course.lessons} lessons
                        </span>
                        <span className="flex items-center gap-1">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          {course.duration}
                        </span>
                      </div>
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-gray-700">Progress</span>
                          <span className="font-semibold text-blue-600">{course.progress}%</span>
                        </div>
                        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className="h-full gradient-button rounded-full transition-all duration-500"
                            style={{ width: `${course.progress}%` }}
                          ></div>
                        </div>
                      </div>
                    </div>
                  </Link>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Sidebar - Takes 1 column */}
          <div className="space-y-6">
            {/* Recent Activity */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="p-6 border-b border-gray-100">
                <h3 className="text-lg font-bold text-gray-900">Recent Activity</h3>
              </div>
              <div className="p-6">
                {recentActivity.length === 0 ? (
                  <div className="text-center py-8">
                    <div className="text-4xl mb-3">📊</div>
                    <p className="text-sm text-gray-600">No activity yet</p>
                    <p className="text-xs text-gray-500 mt-1">Start a course to see your progress here</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {recentActivity.map((activity: typeof recentActivity[0], index: number) => (
                      <div key={index} className="flex gap-3">
                        <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                          activity.type === 'completed' ? 'bg-green-100 text-green-600' :
                          activity.type === 'started' ? 'bg-blue-100 text-blue-600' :
                          activity.type === 'achievement' ? 'bg-amber-100 text-amber-600' :
                          'bg-purple-100 text-purple-600'
                        }`}>
                          {activity.type === 'completed' ? '✓' :
                           activity.type === 'started' ? '▶' :
                           activity.type === 'achievement' ? '★' : '🎯'}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 leading-snug">
                            {activity.title}
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5">{activity.time}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Quick Actions */}
            <div className="gradient-button rounded-2xl shadow-lg p-6 text-white">
              <h3 className="text-lg font-bold mb-2">Ready to Level Up?</h3>
              <p className="text-sm text-blue-100 mb-4">
                Complete your daily lesson to maintain your streak
              </p>
              <button className="w-full bg-white text-blue-600 hover:bg-blue-50 font-medium py-3 px-4 rounded-xl transition-all duration-200 shadow-lg hover:shadow-xl">
                Start Today's Lesson
              </button>
            </div>

            {/* Achievement Preview */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="p-6 border-b border-gray-100">
                <h3 className="text-lg font-bold text-gray-900">Achievements</h3>
              </div>
              <div className="p-6">
                <div className="grid grid-cols-3 gap-3">
                  <div className="text-center p-3 gradient-achievement-amber rounded-xl border border-amber-200">
                    <div className="text-2xl mb-1">🏆</div>
                    <div className="text-xs font-semibold text-gray-700">3 Badges</div>
                  </div>
                  <div className="text-center p-3 gradient-achievement-blue rounded-xl border border-blue-200">
                    <div className="text-2xl mb-1">🎯</div>
                    <div className="text-xs font-semibold text-gray-700">5 Milestones</div>
                  </div>
                  <div className="text-center p-3 gradient-achievement-emerald rounded-xl border border-emerald-200">
                    <div className="text-2xl mb-1">⚡</div>
                    <div className="text-xs font-semibold text-gray-700">8 Day Streak</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

