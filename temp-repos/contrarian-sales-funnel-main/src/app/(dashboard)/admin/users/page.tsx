import { redirect } from 'next/navigation';
import { getCurrentUserWithRole } from '@/lib/auth';
import Link from 'next/link';
import { listUsersWithSubscription } from '@/actions/user';

export default async function AdminUsersPage() {
    const user = await getCurrentUserWithRole();

    if (!user) {
        redirect('/sign-in');
    }

    if (user.role !== 'admin') {
        redirect('/dashboard');
    }

    const res = await listUsersWithSubscription();
    const users = (res.success ? res.users : []) as any[];


    return (
        <div className="min-h-full gradient-bg-admin-page">
            <div className="max-w-7xl mx-auto p-6 lg:p-8 space-y-8">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                    <div>
                        <h1 className="text-3xl lg:text-4xl font-bold text-gray-900 mb-2">
                            Users
                        </h1>
                        <p className="text-base text-gray-600">
                            View and manage all registered users
                        </p>
                    </div>
                    <div className="flex gap-3">
                        <button className="px-5 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-50 transition-all duration-200 font-medium shadow-sm hover:shadow">
                            Export CSV
                        </button>
                        <Link href="/admin">
                            <button className="px-5 py-2.5 gradient-button-indigo text-white rounded-xl transition-all duration-200 font-medium shadow-lg hover:shadow-xl">
                                Back to Dashboard
                            </button>
                        </Link>
                    </div>
                </div>

                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                    <div className="p-6 border-b border-gray-100">
                        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                            <div>
                                <h2 className="text-xl font-bold text-gray-900">All Users</h2>
                                <p className="text-sm text-gray-600 mt-1">
                                    {users.length} total users
                                </p>
                            </div>
                            <div className="flex gap-2">
                                <select className="px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 bg-white">
                                    <option>All Roles</option>
                                    <option>Admin</option>
                                    <option>Student</option>
                                </select>
                                <select className="px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 bg-white">
                                    <option>All Payment Statuses</option>
                                    <option>Completed</option>
                                    <option>Pending</option>
                                    <option>Failed</option>
                                </select>
                                <div className="relative">
                                    <input
                                        type="text"
                                        placeholder="Search name or email…"
                                        className="pl-10 pr-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 w-64"
                                    />
                                    <svg className="w-5 h-5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M10 18a8 8 0 100-16 8 8 0 000 16z" />
                                    </svg>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-gray-50 border-b border-gray-100">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">User</th>
                                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Email</th>
                                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Role</th>
                                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Payment Status</th>
                                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Joined</th>
                                    <th className="px-6 py-3 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {(users as any[]).map((u: any, idx: number) => (
                                    <tr key={idx} className="hover:bg-gray-50 transition-colors">
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <div className="flex items-center">
                                                <div className="w-10 h-10 gradient-avatar rounded-full flex items-center justify-center text-white font-semibold text-sm">
                                                    {`${(u.firstName || '').slice(0,1)}${(u.lastName || '').slice(0,1)}`.trim() || (u.email || '?').slice(0,1).toUpperCase()}
                                                </div>
                                                <div className="ml-3">
                                                    <div className="text-sm font-medium text-gray-900">
                                                        {u.firstName || u.lastName ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : (u.email || 'Unknown')}
                                                    </div>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">{u.email}</td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <span className="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700 capitalize">
                                                {u.role || 'student'}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            {(() => {
                                                const status = (u.subscription?.status || u.subscriptionStatus || 'none') as string;
                                                const cls = status === 'completed'
                                                    ? 'bg-green-100 text-green-700'
                                                    : status === 'pending'
                                                        ? 'bg-amber-100 text-amber-700'
                                                        : 'bg-rose-100 text-rose-700'
                                                ;
                                                return (
                                                    <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${cls}`}>
                                                        {status}
                                                    </span>
                                                );
                                            })()}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                                            {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '-'}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <div className="flex items-center justify-end gap-2">
                                                <button className="px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50">
                                                    View
                                                </button>
                                                <button className="px-3 py-1.5 text-xs font-medium text-rose-700 border border-rose-200 rounded-lg hover:bg-rose-50">
                                                    Disable
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <div className="p-4 border-t border-gray-100">
                        <div className="flex items-center justify-between">
                            <p className="text-xs text-gray-600">
                                Showing <span className="font-semibold">1-{users.length}</span> of <span className="font-semibold">{users.length}</span>
                            </p>
                            <div className="flex items-center gap-2">
                                <button className="px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50" disabled>
                                    Previous
                                </button>
                                <button className="px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50">
                                    Next
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

