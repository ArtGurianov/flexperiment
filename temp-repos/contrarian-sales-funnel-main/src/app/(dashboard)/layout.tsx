'use client';

import { useState } from 'react';
import { useUser } from '@clerk/nextjs';
import { redirect } from 'next/navigation';
import DashboardNav from '@/components/dashboard/DashboardNav';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, isLoaded } = useUser();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  if (!isLoaded) {
    return null; // or a loading spinner
  }

  if (!user) {
    redirect('/sign-in');
  }

  // Get role from user metadata
  const role = (user.publicMetadata?.role as 'admin' | 'student') || 'student';
  const userName = user.firstName || 'User';

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Mobile Header with Hamburger */}
      <div className="fixed top-0 left-0 right-0 z-30 lg:hidden bg-white border-b border-gray-200 h-14 flex items-center px-4">
        <button
          onClick={() => setIsMobileMenuOpen(true)}
          className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
          aria-label="Open menu"
        >
          <svg
            className="w-6 h-6 text-gray-700"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 6h16M4 12h16M4 18h16"
            />
          </svg>
        </button>
        <span className="ml-3 text-base font-semibold text-gray-900">
          {role === 'admin' ? '👨‍💼 Admin Dashboard' : '🎓 My Dashboard'}
        </span>
      </div>

      {/* Mobile Overlay */}
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setIsMobileMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Left Sidebar - Desktop & Mobile */}
      <aside
        className={`
          fixed lg:static inset-y-0 left-0 z-50
          w-64 shrink-0 
          transform transition-transform duration-300 ease-in-out
          ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
      >
        <DashboardNav
          role={role}
          userName={userName}
          onCloseMobile={() => setIsMobileMenuOpen(false)}
          isMobileMenuOpen={isMobileMenuOpen}
        />
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto pt-14 lg:pt-0">
        {children}
      </main>
    </div>
  );
}