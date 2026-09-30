import { redirect } from 'next/navigation';
import { getCurrentUserWithRole } from '@/lib/auth';
// Server actions for admin dashboard
import { getAdminDashboardData } from '@/actions/user';
import Link from 'next/link';
import StatsGrid from '@/components/admin/StatsGrid';
import QuickActions from '@/components/admin/QuickActions';
import PendingSubscriptionsAlert from '@/components/admin/PendingSubscriptionsAlert';
import RecentUsersTable from '@/components/admin/RecentUsersTable';
import RecentActivityList from '@/components/admin/RecentActivityList';
import TopCoursesList from '@/components/admin/TopCoursesList';
import SystemStatusCard from '@/components/admin/SystemStatusCard';
import SupportCard from '@/components/admin/SupportCard';

export default async function AdminDashboardPage() {
  const user = await getCurrentUserWithRole();

  if (!user) {
    redirect('/sign-in');
  }

  // Require admin role
  if (user.role !== 'admin') {
    redirect('/dashboard');
  }

  // Fetch dashboard data
  const dashboardRes = await getAdminDashboardData();
  const { stats: statsRaw, recentUsers, topCourses, pendingSubscriptions } = dashboardRes.success
    ? (dashboardRes.data as any)
    : { stats: null, recentUsers: [], topCourses: [], pendingSubscriptions: [] };
  const defaultStats = {
    totalUsers: 0,
    totalCourses: 0,
    monthlyRevenue: 0,
    activeStudents: 0,
    newUsersToday: 0,
    completionRate: 0,
    avgEngagement: 0,
    supportTickets: 0,
    pendingSubscriptions: Array.isArray(pendingSubscriptions) ? pendingSubscriptions.length : 0,
  };
  const stats = (dashboardRes.success ? statsRaw : null) || defaultStats;
  // Lightweight mock recent activity (no events system yet)
  const recentActivity = [
    { type: 'user', message: 'New user registration', time: '2 hours ago' },
    { type: 'revenue', message: 'New purchase processed', time: '3 hours ago' },
    { type: 'completion', message: 'Students completed lessons', time: '5 hours ago' },
    { type: 'support', message: 'No support system connected', time: '6 hours ago' },
    { type: 'course', message: 'Course updated', time: '1 day ago' },
  ];

  return (
    <div className="min-h-full gradient-bg-admin-page">
      <div className="max-w-7xl mx-auto p-6 lg:p-8 space-y-8">
        {/* Welcome Header */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h1 className="text-3xl lg:text-4xl font-bold text-gray-900 mb-2">
              Admin Dashboard
            </h1>
            <p className="text-base text-gray-600">
              Monitor and manage your platform performance
            </p>
          </div>
          <div className="flex gap-3">
            <Link href="/admin/users">
              <button className="px-5 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-50 transition-all duration-200 font-medium shadow-sm hover:shadow">
                Manage Users
              </button>
            </Link>
            <Link href="/admin/courses">
              <button className="px-5 py-2.5 gradient-button-indigo text-white rounded-xl transition-all duration-200 font-medium shadow-lg hover:shadow-xl">
                Add Course
              </button>
            </Link>
          </div>
        </div>

        {/* Stats Grid - Top Row */}
        <StatsGrid stats={stats} />

        {/* Quick Actions */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Link href="/admin/users">
            <div className="group bg-white rounded-xl border border-gray-200 p-5 hover:border-indigo-300 hover:shadow-lg transition-all duration-300 cursor-pointer">
              <div className="flex items-center justify-between mb-3">
                <div className="bg-indigo-100 p-3 rounded-xl group-hover:bg-indigo-200 transition-colors">
                  <svg className="w-6 h-6 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                  </svg>
                </div>
                <svg className="w-5 h-5 text-gray-400 group-hover:text-indigo-600 group-hover:translate-x-1 transition-all" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
              <h3 className="text-base font-semibold text-gray-900 mb-1">User Management</h3>
              <p className="text-sm text-gray-600">View and manage users</p>
            </div>
          </Link>

          <Link href="/admin/courses">
            <div className="group bg-white rounded-xl border border-gray-200 p-5 hover:border-purple-300 hover:shadow-lg transition-all duration-300 cursor-pointer">
              <div className="flex items-center justify-between mb-3">
                <div className="bg-purple-100 p-3 rounded-xl group-hover:bg-purple-200 transition-colors">
                  <svg className="w-6 h-6 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                  </svg>
                </div>
                <svg className="w-5 h-5 text-gray-400 group-hover:text-purple-600 group-hover:translate-x-1 transition-all" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
              <h3 className="text-base font-semibold text-gray-900 mb-1">Course Management</h3>
              <p className="text-sm text-gray-600">Create and edit courses</p>
            </div>
          </Link>

          <Link href="/admin/analytics">
            <div className="group bg-white rounded-xl border border-gray-200 p-5 hover:border-blue-300 hover:shadow-lg transition-all duration-300 cursor-pointer">
              <div className="flex items-center justify-between mb-3">
                <div className="bg-blue-100 p-3 rounded-xl group-hover:bg-blue-200 transition-colors">
                  <svg className="w-6 h-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                </div>
                <svg className="w-5 h-5 text-gray-400 group-hover:text-blue-600 group-hover:translate-x-1 transition-all" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
              <h3 className="text-base font-semibold text-gray-900 mb-1">Analytics</h3>
              <p className="text-sm text-gray-600">Track performance</p>
            </div>
          </Link>

          <Link href="/admin/settings">
            <div className="group bg-white rounded-xl border border-gray-200 p-5 hover:border-gray-400 hover:shadow-lg transition-all duration-300 cursor-pointer">
              <div className="flex items-center justify-between mb-3">
                <div className="bg-gray-100 p-3 rounded-xl group-hover:bg-gray-200 transition-colors">
                  <svg className="w-6 h-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                <svg className="w-5 h-5 text-gray-400 group-hover:text-gray-600 group-hover:translate-x-1 transition-all" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
              <h3 className="text-base font-semibold text-gray-900 mb-1">Settings</h3>
              <p className="text-sm text-gray-600">Platform configuration</p>
            </div>
          </Link>
        </div>

        {/* Pending Subscriptions Alert - Shows prominently if any exist */}
        <PendingSubscriptionsAlert pendingSubscriptions={pendingSubscriptions} />

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Recent Users & Activity - 2 columns */}
          <div className="lg:col-span-2 space-y-6">
            {/* Recent Users */}
            <RecentUsersTable recentUsers={recentUsers} />

            {/* Recent Activity */}
            <RecentActivityList recentActivity={recentActivity} />
          </div>

          {/* Sidebar - 1 column */}
          <div className="space-y-6">
            {/* Top Courses */}
            <TopCoursesList topCourses={topCourses as any[]} />

            {/* System Status */}
            <SystemStatusCard />

            {/* Support Tickets */}
            <SupportCard supportTickets={stats.supportTickets} />
          </div>
        </div>
      </div>
    </div>
  );
}
