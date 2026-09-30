import { auth, currentUser } from '@clerk/nextjs/server';

export type UserRole = 'admin' | 'student';

/**
 * Get the current user's role from Clerk public metadata
 */
export async function getUserRole(): Promise<UserRole> {
  const user = await currentUser();
  
  if (!user) {
    return 'student'; // Default role for non-authenticated users
  }
  
  // Check public metadata for role
  const role = user.publicMetadata?.role as string;
  
  return role === 'admin' ? 'admin' : 'student';
}

/**
 * Check if the current user is an admin
 */
export async function isAdmin(): Promise<boolean> {
  const role = await getUserRole();
  return role === 'admin';
}

/**
 * Get user data with role
 */
export async function getCurrentUserWithRole() {
  const user = await currentUser();
  
  if (!user) {
    return null;
  }
  
  const role = await getUserRole();
  
  return {
    id: user.id,
    email: user.emailAddresses[0]?.emailAddress,
    firstName: user.firstName,
    lastName: user.lastName,
    imageUrl: user.imageUrl,
    role,
  };
}

/**
 * Require authentication, redirect to sign-in if not authenticated
 */
export async function requireAuth() {
  const { userId } = await auth();
  
  if (!userId) {
    throw new Error('Unauthorized');
  }
  
  return userId;
}

/**
 * Require admin role, throw error if not admin
 */
export async function requireAdmin() {
  await requireAuth();
  const admin = await isAdmin();
  
  if (!admin) {
    throw new Error('Forbidden: Admin access required');
  }
}

