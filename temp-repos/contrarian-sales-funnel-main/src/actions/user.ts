'use server';

import { currentUser } from '@clerk/nextjs/server';
import connectDB from '@/lib/mongodb';
import User from '@/models/User';
import Subscription from '@/models/Subscription';
import mongoose from 'mongoose';
import Course from '@/models/Course';
import UserProgress from '@/models/UserProgress';

export async function syncUserToDatabase() {
  try {
    // Get the current user from Clerk
    const clerkUser = await currentUser();

    if (!clerkUser) {
      return { success: false, message: 'User not authenticated' };
    }

    // Connect to MongoDB
    await connectDB();

    // Check if user already exists
    let user = await User.findOne({ clerkId: clerkUser.id });

    if (user) {
      // Update existing user
      user.email = clerkUser.emailAddresses[0]?.emailAddress || user.email;
      user.firstName = clerkUser.firstName || user.firstName;
      user.lastName = clerkUser.lastName || user.lastName;
      user.imageUrl = clerkUser.imageUrl || user.imageUrl;
      await user.save();

      return {
        success: true,
        message: 'User updated successfully',
        user: {
          id: (user._id as mongoose.Types.ObjectId).toString(),
          clerkId: user.clerkId,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
        },
      };
    } else {
      // Create new user
      user = await User.create({
        clerkId: clerkUser.id,
        email: clerkUser.emailAddresses[0]?.emailAddress,
        firstName: clerkUser.firstName,
        lastName: clerkUser.lastName,
        imageUrl: clerkUser.imageUrl,
      });

      return {
        success: true,
        message: 'User created successfully',
        user: {
          id: (user._id as mongoose.Types.ObjectId).toString(),
          clerkId: user.clerkId,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
        },
      };
    }
  } catch (error) {
    console.error('Error syncing user to database:', error);
    return {
      success: false,
      message: 'Failed to sync user to database',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Admin: List users with subscription status
 */
export async function listUsersWithSubscription() {
  try {
    await connectDB();
    // Users + Subscriptions (by clerkId only), pick best per user:
    // 1) prefer completed status, 2) then most recent by createdAt
    const results = await User.aggregate([
      { $sort: { createdAt: -1 } },
      {
        $project: {
          clerkId: 1,
          email: 1,
          firstName: 1,
          lastName: 1,
          imageUrl: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      // Lookup only by clerkId with pipeline to prefer completed and latest
      {
        $lookup: {
          from: 'subscriptions',
          let: { cid: '$clerkId' },
          pipeline: [
            { $match: { $expr: { $eq: ['$clerkId', '$$cid'] } } },
            {
              $addFields: {
                statusPriority: { $cond: [{ $eq: ['$status', 'completed'] }, 0, 1] },
              },
            },
            { $sort: { statusPriority: 1, createdAt: -1 } },
            {
              $project: {
                _id: 0,
                status: 1,
                amount: 1,
                currency: 1,
                stripePaymentIntentId: 1,
                stripeCustomerId: 1,
                purchaseDate: 1,
                activatedAt: 1,
                createdAt: 1,
                updatedAt: 1,
              },
            },
            { $limit: 1 },
          ],
          as: 'subscriptionArr',
        },
      },
      { $addFields: { subscription: { $arrayElemAt: ['$subscriptionArr', 0] } } },
      { $addFields: { subscriptionStatus: { $ifNull: ['$subscription.status', 'none'] } } },
      { $project: { subscriptionArr: 0 } },
    ]);
    for (const r of results) (r as any).role = 'student';
    return { success: true, users: JSON.parse(JSON.stringify(results)) };
  } catch (error) {
    console.error('Error listing users with subscription:', error);
    return { success: false, error: 'Failed to fetch users' };
  }
}

/**
 * Admin: Recent users with subscription info (latest first)
 */
export async function getRecentUsersWithSubscription(limit = 5) {
  try {
    await connectDB();
    const results = await User.aggregate([
      { $sort: { createdAt: -1 } },
      { $limit: limit },
      {
        $project: {
          clerkId: 1,
          email: 1,
          firstName: 1,
          lastName: 1,
          imageUrl: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      {
        $lookup: {
          from: 'subscriptions',
          let: { cid: '$clerkId' },
          pipeline: [
            { $match: { $expr: { $eq: ['$clerkId', '$$cid'] } } },
            {
              $addFields: {
                statusPriority: { $cond: [{ $eq: ['$status', 'completed'] }, 0, 1] },
              },
            },
            { $sort: { statusPriority: 1, createdAt: -1 } },
            {
              $project: {
                _id: 0,
                status: 1,
                amount: 1,
                currency: 1,
                stripePaymentIntentId: 1,
                stripeCustomerId: 1,
                purchaseDate: 1,
                activatedAt: 1,
                createdAt: 1,
                updatedAt: 1,
              },
            },
            { $limit: 1 },
          ],
          as: 'subscriptionArr',
        },
      },
      { $addFields: { subscription: { $arrayElemAt: ['$subscriptionArr', 0] } } },
      { $addFields: { subscriptionStatus: { $ifNull: ['$subscription.status', 'none'] } } },
      { $project: { subscriptionArr: 0 } },
    ]);
    // Add role for consistency
    for (const r of results) (r as any).role = 'student';
    return { success: true, users: JSON.parse(JSON.stringify(results)) };
  } catch (error) {
    console.error('Error fetching recent users:', error);
    return { success: false, error: 'Failed to fetch recent users' };
  }
}

/**
 * Admin: Dashboard data (stats, recent users, top courses, pending subscriptions)
 */
export async function getAdminDashboardData() {
  try {
    await connectDB();
    // Counts
    const [
      totalUsers,
      totalCourses,
      totalEnrollments,
      completedCourses,
      totalCompletedSubs,
      pendingSubsCount,
      monthlyRevenueAgg,
      avgEngagementAgg,
      topCourses,
      recentUsersRes,
      pendingSubscriptions,
    ] = await Promise.all([
      User.countDocuments(),
      Course.countDocuments(),
      UserProgress.countDocuments(),
      UserProgress.countDocuments({ isCompleted: true }),
      Subscription.countDocuments({ status: 'completed' }),
      Subscription.countDocuments({ status: 'pending' }),
      // Monthly revenue for current month
      Subscription.aggregate([
        {
          $match: {
            status: 'completed',
            purchaseDate: {
              $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
            },
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      // Average engagement = average overallProgress across all UserProgress
      UserProgress.aggregate([
        { $group: { _id: null, avgProgress: { $avg: '$overallProgress' } } },
      ]),
      Course.find({ isPublished: true })
        .sort({ enrolledCount: -1 })
        .limit(3)
        .select('title enrolledCount price rating')
        .lean(),
      getRecentUsersWithSubscription(5),
      Subscription.find({ status: 'pending' }).sort({ purchaseDate: -1 }).lean(),
    ]);
    // New users today
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const newUsersToday = await User.countDocuments({ createdAt: { $gte: startOfToday } });
    const monthlyRevenue = monthlyRevenueAgg[0]?.total || 0;
    const completionRate =
      totalEnrollments > 0 ? Math.round((completedCourses / totalEnrollments) * 100) : 0;
    const avgEngagement = Math.round((avgEngagementAgg[0]?.avgProgress || 0) * 10) / 10;
    const recentUsers =
      (recentUsersRes as any)?.success ? (recentUsersRes as any).users : [];
    const topCoursesTransformed = topCourses.map((c: any) => ({
      title: c.title,
      enrolled: c.enrolledCount || 0,
      revenue: c.price ? `$${(c.enrolledCount * c.price).toLocaleString()}` : '$0',
      rating: c.rating ?? 0,
    }));
    return {
      success: true,
      data: {
        stats: {
          totalUsers,
          totalCourses,
          monthlyRevenue,
          activeStudents: totalCompletedSubs, // proxy for active subscribers
          newUsersToday,
          completionRate,
          avgEngagement,
          supportTickets: 0, // no ticketing system yet
          pendingSubscriptions: pendingSubsCount,
        },
        recentUsers,
        topCourses: topCoursesTransformed,
        pendingSubscriptions: JSON.parse(JSON.stringify(pendingSubscriptions)),
      },
    };
  } catch (error) {
    console.error('Error fetching admin dashboard data:', error);
    return { success: false, error: 'Failed to fetch dashboard data' };
  }
}

