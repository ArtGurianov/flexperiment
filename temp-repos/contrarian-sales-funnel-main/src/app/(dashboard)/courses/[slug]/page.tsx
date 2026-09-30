'use client';

import { useEffect, useState, useRef, useOptimistic, useTransition } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getCourseBySlug, updateLessonCompletion, getUserCourseProgress } from '@/actions/course';
import { useUser } from '@clerk/nextjs';
import { YouTubeProps, YouTubePlayer } from 'react-youtube';
import VideoPlayer from '@/components/courses/VideoPlayer';
import LessonActions from '@/components/courses/LessonActions';
import ResourcesList from '@/components/courses/ResourcesList';
import CourseContentSidebar from '@/components/courses/CourseContentSidebar';

interface Lesson {
  _id: string;
  title: string;
  description?: string;
  videoUrl?: string;
  videoDuration?: number;
  order: number;
  isFree?: boolean;
  resources?: {
    title: string;
    url: string;
    type: 'pdf' | 'doc' | 'video' | 'link' | 'other';
  }[];
}

interface Module {
  _id: string;
  title: string;
  description?: string;
  order: number;
  lessons: Lesson[];
}

interface Course {
  _id: string;
  title: string;
  slug: string;
  description: string;
  shortDescription?: string;
  modules: Module[];
  thumbnail?: string;
  instructorName?: string;
  category: string;
  difficulty: string;
  totalDuration?: number;
  totalLessons?: number;
  rating?: number;
  learningOutcomes?: string[];
}

export default function CourseDetailsPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const { user } = useUser();
  const playerRef = useRef<YouTubePlayer | null>(null);

  const [course, setCourse] = useState<Course | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentLesson, setCurrentLesson] = useState<Lesson | null>(null);
  const [currentModule, setCurrentModule] = useState<Module | null>(null);
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());
  const [completedLessonsState, setCompletedLessonsState] = useState<Set<string>>(new Set());
  const [showCompleteAnimation, setShowCompleteAnimation] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  // Use transition for optimistic updates
  const [isPending, startTransition] = useTransition();

  // Use optimistic updates for instant UI feedback
  const [optimisticCompleted, setOptimisticCompleted] = useOptimistic(
    completedLessonsState,
    (state, lessonId: string) => {
      const newSet = new Set(state);
      if (newSet.has(lessonId)) {
        newSet.delete(lessonId);
      } else {
        newSet.add(lessonId);
      }
      return newSet;
    }
  );
  
  // Use optimistic state in the component
  const completedLessons = optimisticCompleted;

  useEffect(() => {
    const fetchCourse = async () => {
      try {
        const result = await getCourseBySlug(slug);
        
        if (result.success && result.course) {
          setCourse(result.course);
          
          // Load user's progress from database
          if (user?.id) {
            const progressResult = await getUserCourseProgress(user.id, result.course._id);
            if (progressResult.success && progressResult.progress) {
              // Extract completed lesson IDs
              const completed = new Set<string>();
              progressResult.progress.modules.forEach((module: any) => {
                module.lessons.forEach((lesson: any) => {
                  if (lesson.completed) {
                    completed.add(lesson.lessonId);
                  }
                });
              });
              setCompletedLessonsState(completed);
            }
          }
          
          // Auto-select first lesson
          if (result.course.modules?.[0]?.lessons?.[0]) {
            const firstModule = result.course.modules[0];
            const firstLesson = firstModule.lessons[0];
            setCurrentModule(firstModule);
            setCurrentLesson(firstLesson);
            setExpandedModules(new Set([firstModule._id]));
          }
        } else {
          console.error('Course not found');
        }
      } catch (error) {
        console.error('Error fetching course:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchCourse();
  }, [slug, user]);

  const toggleModule = (moduleId: string) => {
    setExpandedModules(prev => {
      const newSet = new Set(prev);
      if (newSet.has(moduleId)) {
        newSet.delete(moduleId);
      } else {
        newSet.add(moduleId);
      }
      return newSet;
    });
  };

  const selectLesson = (module: Module, lesson: Lesson) => {
    setCurrentModule(module);
    setCurrentLesson(lesson);
    // Scroll to top of page when changing lessons
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const markLessonComplete = async (lessonId: string) => {
    if (!user?.id || !course?._id) return;
    
    const wasCompleted = completedLessonsState.has(lessonId);
    const newCompleted = !wasCompleted;
    
    // Show animation for completion
    if (newCompleted) {
      setShowCompleteAnimation(true);
      setTimeout(() => setShowCompleteAnimation(false), 2000);
    }
    
    // Wrap optimistic update in transition
    startTransition(() => {
      // Trigger optimistic update (instant UI feedback)
      setOptimisticCompleted(lessonId);
    });
    
    // Save to database in background
    try {
      const result = await updateLessonCompletion(
        user.id,
        course._id,
        lessonId,
        newCompleted
      );
      
      if (result.success) {
        // Update actual state on success
        setCompletedLessonsState(prev => {
          const newSet = new Set(prev);
          if (newCompleted) {
            newSet.add(lessonId);
          } else {
            newSet.delete(lessonId);
          }
          return newSet;
        });
      } else {
        // On error, reset to previous state
        setCompletedLessonsState(new Set(completedLessonsState));
        console.error('Failed to update lesson completion:', result.error);
      }
    } catch (error) {
      // On error, reset to previous state
      setCompletedLessonsState(new Set(completedLessonsState));
      console.error('Error updating lesson completion:', error);
    }
  };

  const getAllLessons = (): { module: Module; lesson: Lesson }[] => {
    if (!course) return [];
    const lessons: { module: Module; lesson: Lesson }[] = [];
    course.modules.forEach(module => {
      module.lessons.forEach(lesson => {
        lessons.push({ module, lesson });
      });
    });
    return lessons;
  };

  const getCurrentLessonIndex = () => {
    if (!currentLesson) return -1;
    const allLessons = getAllLessons();
    return allLessons.findIndex(item => item.lesson._id === currentLesson._id);
  };

  const goToNextLesson = () => {
    const allLessons = getAllLessons();
    const currentIndex = getCurrentLessonIndex();
    if (currentIndex < allLessons.length - 1) {
      const next = allLessons[currentIndex + 1];
      selectLesson(next.module, next.lesson);
      setExpandedModules(prev => new Set([...prev, next.module._id]));
    }
  };

  const goToPreviousLesson = () => {
    const allLessons = getAllLessons();
    const currentIndex = getCurrentLessonIndex();
    if (currentIndex > 0) {
      const prev = allLessons[currentIndex - 1];
      selectLesson(prev.module, prev.lesson);
      setExpandedModules(prevSet => new Set([...prevSet, prev.module._id]));
    }
  };

  
  const togglePlayPause = () => {
    if (!playerRef.current) return;
    
    if (isPlaying) {
      playerRef.current.pauseVideo();
    } else {
      playerRef.current.playVideo();
    }
  };

  const toggleFullscreen = () => {
    if (!playerRef.current) return;
    
    const iframe = playerRef.current.getIframe();
    if (!iframe) return;
    
    if (!isFullscreen) {
      if (iframe.requestFullscreen) {
        iframe.requestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
    setIsFullscreen(!isFullscreen);
  };

  const calculateProgress = () => {
    if (!course) return 0;
    const totalLessons = getAllLessons().length;
    if (totalLessons === 0) return 0;
    return Math.round((completedLessons.size / totalLessons) * 100);
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // YouTube player event handlers
  const onPlayerReady = (player: YouTubePlayer) => {
    playerRef.current = player;
  };

  const onPlayerStateChange: YouTubeProps['onStateChange'] = async (event) => {
    // YouTube Player States: -1 (unstarted), 0 (ended), 1 (playing), 2 (paused), 3 (buffering), 5 (cued)
    setIsPlaying(event.data === 1);
    
    // Auto-mark lesson complete when video ends
    if (event.data === 0 && currentLesson && !completedLessons.has(currentLesson._id)) {
      await markLessonComplete(currentLesson._id);
    }
  };
  // Kept in VideoPlayer, not needed here

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      
      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          goToNextLesson();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          goToPreviousLesson();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          break;
        case ' ':
          e.preventDefault();
          togglePlayPause();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [currentLesson, course, isPlaying]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center gradient-bg-page">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-600 text-lg">Loading course...</p>
        </div>
      </div>
    );
  }

  if (!course) {
    return (
      <div className="min-h-screen flex items-center justify-center gradient-bg-page">
        <div className="text-center">
          <div className="text-6xl mb-4">📚</div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Course Not Found</h2>
          <p className="text-gray-600 mb-6">The course you're looking for doesn't exist.</p>
          <button
            onClick={() => router.push('/dashboard')}
            className="px-6 py-3 gradient-button text-white rounded-xl font-medium"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen gradient-bg-page">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4 flex-1">
              <button
                onClick={() => router.push('/dashboard')}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                title="Back to Dashboard"
              >
                <svg className="w-6 h-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <div className="flex-1 min-w-0">
                <h1 className="text-xl font-bold text-gray-900 truncate">{course.title}</h1>
                <p className="text-sm text-gray-600">{course.instructorName || 'Expert Instructor'}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right hidden sm:block">
                <p className="text-xs text-gray-500">Your Progress</p>
                <p className="text-sm font-bold text-blue-600">{calculateProgress()}%</p>
              </div>
              <span className="text-sm text-gray-600 hidden md:block">
                {completedLessons.size}/{getAllLessons().length} completed
              </span>
            </div>
          </div>
          {/* Progress Bar */}
          <div className="w-full bg-gray-200 h-2 rounded-full overflow-hidden">
            <div 
              className="h-full bg-linear-to-r from-blue-600 to-purple-600 transition-all duration-500"
              style={{ width: `${calculateProgress()}%` }}
            ></div>
          </div>
        </div>
      </div>

      {/* Success Animation */}
      {showCompleteAnimation && (
        <div className="fixed top-20 right-6 z-50 bg-green-500 text-white px-6 py-3 rounded-lg shadow-lg flex items-center gap-3 animate-bounce">
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
          <span className="font-semibold">Lesson Complete! 🎉</span>
        </div>
      )}

      {/* Main Content */}
      <div className="max-w-7xl mx-auto p-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Video Player - 2 columns */}
          <div className="lg:col-span-2 space-y-6">
            {/* Video */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <VideoPlayer
                videoUrl={currentLesson?.videoUrl}
                onReady={onPlayerReady}
                onStateChange={onPlayerStateChange}
              />

              {/* Lesson Info */}
              <div className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex-1">
                    <h2 className="text-2xl font-bold text-gray-900 mb-2">
                      {currentLesson?.title || 'Select a lesson'}
                    </h2>
                    {currentModule && (
                      <p className="text-sm text-gray-600 mb-3">
                        Module: {currentModule.title}
                      </p>
                    )}
                  </div>
                  {currentLesson?.videoDuration && (
                    <span className="text-sm font-medium text-gray-600 bg-gray-100 px-3 py-1 rounded-full">
                      {formatDuration(currentLesson.videoDuration)}
                    </span>
                  )}
                </div>

                {currentLesson?.description && (
                  <div className="prose max-w-none mb-6">
                    <p className="text-gray-700 leading-relaxed">{currentLesson.description}</p>
                  </div>
                )}

                {/* Action Buttons */}
                <LessonActions
                  isCompleted={!!(currentLesson && completedLessons.has(currentLesson._id))}
                  onToggleComplete={() => currentLesson && markLessonComplete(currentLesson._id)}
                  onPrev={goToPreviousLesson}
                  onNext={goToNextLesson}
                  disablePrev={getCurrentLessonIndex() === 0}
                  disableNext={getCurrentLessonIndex() === getAllLessons().length - 1}
                />

                {/* Resources */}
                <ResourcesList resources={currentLesson?.resources} />
              </div>
            </div>

            {/* Course Description Tab */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
              <h3 className="text-xl font-bold text-gray-900 mb-4">About This Course</h3>
              <p className="text-gray-700 leading-relaxed mb-6">{course.description}</p>

              {course.learningOutcomes && course.learningOutcomes.length > 0 && (
                <div>
                  <h4 className="text-lg font-bold text-gray-900 mb-3">What You'll Learn</h4>
                  <ul className="space-y-2">
                    {course.learningOutcomes.map((outcome, idx) => (
                      <li key={idx} className="flex items-start gap-3">
                        <svg className="w-5 h-5 text-green-500 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                        <span className="text-gray-700">{outcome}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>

          {/* Sidebar - Course Content */}
          <div className="lg:col-span-1">
            <CourseContentSidebar
              modules={course.modules}
              expandedModules={expandedModules}
              onToggleModule={toggleModule}
              currentLessonId={currentLesson?._id}
              completedLessons={completedLessons}
              onSelectLesson={selectLesson}
              totalLessons={course.totalLessons}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

