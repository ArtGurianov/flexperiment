<!-- 4e8a9c07-d155-41bd-a300-e6f934678edb e5f51901-4d9b-4d2d-904f-45f4c500898a -->
# Udemy LMS AI Clone Build Plan (Revised)

## Phase 1: Foundation & Simplified Schema (Weeks 1-2)

### 1.1 Setup Sanity Schemas (YOU-163)

Create simplified schema with reference-based structure:

**Schema Types:**

**`lessonType.ts`** - Individual lesson document

- `title` (string, required)
- `description` (text)
- `slug` (slug, required, unique)
- `video` (mux.video) - Mux video asset
- `content` (array of block) - Rich text content
- `duration` (number) - Video duration in seconds
- `order` (number) - Order within module
- `isFree` (boolean) - Free preview lesson
- `completedBy` (array of strings) - Array of Clerk user IDs who completed this lesson

**`moduleType.ts`** - Course section document

- `title` (string, required)
- `description` (text)
- `slug` (slug, required)
- `order` (number) - Order within course
- `lessons` (array of references to lesson) - Array of lesson references
- `completedBy` (array of strings) - Array of Clerk user IDs who completed this module

**`courseType.ts`** - Main course document

- `title` (string, required)
- `description` (text)
- `slug` (slug, required, unique)
- `thumbnail` (image with hotspot)
- `modules` (array of references to module) - Array of module references
- `category` (reference to category)
- `tier` (string with options.list: ['free', 'pro', 'ultra'], layout: radio)
- `published` (boolean)
- `featured` (boolean) - Show on homepage
- `completedBy` (array of strings) - Array of Clerk user IDs who completed entire course

**`categoryType.ts`** - Course categories

- `title` (string, required)
- `slug` (slug, required)
- `icon` (string) - Icon name from lucide-react
- `description` (text)

**Key Structure:**

```
Course (document)
  └─ modules: [Reference → Module, Reference → Module]
      
Module (document)
  └─ lessons: [Reference → Lesson, Reference → Lesson]

Lesson (document)
  └─ video: Mux asset
```

**Completion Tracking Logic:**

- Mark lesson complete: Add user ID to `lesson.completedBy[]`
- Module is complete when: ALL lessons in `module.lessons[]` have user ID in their `completedBy[]`
- Course is complete when: ALL modules in `course.modules[]` are complete

**Files to create:**

- `sanity/schemaTypes/lessonType.ts`
- `sanity/schemaTypes/moduleType.ts`
- `sanity/schemaTypes/courseType.ts`
- `sanity/schemaTypes/categoryType.ts`
- Update `sanity/schemaTypes/index.ts` to register all types

### 1.2 Configure Clerk (YOU-177 - Part 1)

- Install `@clerk/nextjs`
- Set up environment variables (`.env.local`)
- Wrap [`app/layout.tsx`](app/layout.tsx) with `<ClerkProvider>`
- Create `middleware.ts` for protected routes
- Store subscription tier in Clerk: `publicMetadata: { tier: 'free' | 'pro' | 'ultra' }`
- Create helper: `lib/auth-helpers.ts` with functions to get current user and tier

### 1.3 Configure Mux (YOU-175 - Part 1)

- Install `@mux/mux-node`, `@sanity/asset-source-mux`, `@mux/mux-player-react`
- Set up Mux environment variables (token, access token)
- Add Mux plugin to [`sanity.config.ts`](sanity.config.ts)
- Test video upload in Sanity Studio

**Deliverable:** Complete schema with references, auth, and video infrastructure

---

## Phase 2: Core Admin Infrastructure (Weeks 3-4)

### 2.1 Setup Reusable App SDK Component (YOU-164)

Create flexible document editor using `useDocument` from `@sanity/sdk-react`:

**File:** `components/admin/DocumentEditor.tsx`

Features:

- Accepts `documentType` and `documentId` props
- Uses `useDocument()` hook for real-time state
- Supports field rendering based on schema type
- Handles `patch()` and `commit()` operations
- Displays validation errors
- Shows save status (saving/saved)
```typescript
// Core pattern
const { document, patch, commit, isLoading } = useDocument({
  documentId: docId,
  documentType: docType
})

const handleFieldChange = (field: string, value: any) => {
  patch(doc => doc.set(field, value))
  commit()
}
```


### 2.2 Build Admin Input Components (YOU-172)

Create input components that integrate with `useDocument`:

**Components to create:**

- `components/admin/inputs/TextInput.tsx` - String/text fields
- `components/admin/inputs/RichTextInput.tsx` - Portable text with formatting
- `components/admin/inputs/ImageInput.tsx` - Image upload with hotspot
- `components/admin/inputs/ReferenceArrayInput.tsx` - Select/manage reference arrays
- `components/admin/inputs/SelectInput.tsx` - Dropdown/radio selections
- `components/admin/inputs/MuxVideoInput.tsx` - Mux video upload/preview (YOU-175)
- `components/admin/inputs/BooleanInput.tsx` - Toggle/checkbox
- `components/admin/inputs/NumberInput.tsx` - Number input
- `components/admin/inputs/SlugInput.tsx` - Slug generator

Each component:

- Receives `value`, `onChange`, `validation` props
- Integrates with parent's `patch()` function
- Shows validation state
- Handles loading states

### 2.3 Admin Routes & Layout

**Admin structure:**

**Files:**

- `app/admin/layout.tsx` - Admin shell with nav, auth check (must be logged in)
- `app/admin/page.tsx` - Dashboard (stats: total courses, lessons, categories)
- `components/admin/AdminNav.tsx` - Navigation sidebar
- `lib/admin-helpers.ts` - Helper functions for admin operations

**Routes:**

- `/admin` - Dashboard
- `/admin/courses` - List all courses
- `/admin/courses/new` - Create course
- `/admin/courses/[id]` - Edit course
- `/admin/modules` - List all modules
- `/admin/modules/new` - Create module
- `/admin/modules/[id]` - Edit module
- `/admin/lessons` - List all lessons
- `/admin/lessons/new` - Create lesson
- `/admin/lessons/[id]` - Edit lesson
- `/admin/categories` - Manage categories

**Deliverable:** Complete admin infrastructure for managing all content types

---

## Phase 3: Admin Content Management (Weeks 5-6)

### 3.1 Course Management (YOU-173 Part 1, YOU-174, YOU-176)

**`app/admin/courses/page.tsx`** - Course list page

- Query all courses using `client.fetch()` with live query
- Display as cards/table with thumbnail, title, tier, published status
- Filter by tier, published status, category
- Actions: Edit, Delete, Duplicate, Publish/Unpublish
- **Create New Course button** (YOU-174) → navigates to `/admin/courses/new`

**`app/admin/courses/new/page.tsx`** - Create new course

- Form with basic fields (title, description, tier, category)
- Creates draft course document
- Redirects to edit page after creation

**`app/admin/courses/[id]/page.tsx`** - Edit course (YOU-176)

- Use `DocumentEditor` component
- Tabs:
  - **Basic Info**: title, description, thumbnail, category, tier, featured, published
  - **Modules**: Manage module references (add/remove/reorder)
  - **Preview**: See course structure tree
- Display module list with expand/collapse
- "Add Module" button → opens modal to select existing or create new

**Component:** `components/admin/CourseEditor.tsx`

- Wraps `DocumentEditor` with course-specific layout
- Module array management with drag-and-drop reordering
- Visual course structure preview

### 3.2 Module Management

**`app/admin/modules/page.tsx`** - Module list

- Query all modules
- Display with lesson count, order
- Filter by course (optional)
- Actions: Edit, Delete

**`app/admin/modules/[id]/page.tsx`** - Edit module

- Use `DocumentEditor` component
- Fields: title, description, slug, order
- **Lessons array**: Manage lesson references (add/remove/reorder)
- "Add Lesson" button → opens modal to select existing or create new
- Display lesson list with expand/collapse

### 3.3 Lesson Management & Mux Video (YOU-175)

**`app/admin/lessons/page.tsx`** - Lesson list

- Query all lessons
- Display with video thumbnail, duration, free status
- Filter by module (optional)
- Actions: Edit, Delete

**`app/admin/lessons/[id]/page.tsx`** - Edit lesson (YOU-175)

- Use `DocumentEditor` with lesson schema
- Fields: title, description, slug, order, isFree, duration
- **Mux Video Upload** (`MuxVideoInput.tsx`):
  - Upload button triggers Mux direct upload
  - Show upload progress bar
  - Display video preview after upload
  - "Remove Video" button
  - Store Mux asset data in lesson document
- Rich text editor for lesson content
- Auto-save changes

**Deliverable:** Full admin workflow for managing courses, modules, and lessons with video upload

---

## Phase 4: Student Experience (Weeks 7-8)

### 4.1 Landing Page (YOU-162)

**File:** `app/page.tsx`

Sections:

- **Hero**: Title, subtitle, CTA ("Browse Courses")
- **Featured Courses**: Query courses where `featured: true`, display as cards
- **Browse by Category**: Show all categories with icons, link to filtered course list
- **Stats**: Total courses, lessons, students (mock data initially)
- **Footer**: Links, social media

Use Shadcn components: Card, Button, Badge

### 4.2 Course List Student View (YOU-166, YOU-173 Part 2)

**File:** `app/courses/page.tsx`

Features:

- Query published courses: `*[_type == "course" && published == true]`
- Display as grid of course cards
- Show: thumbnail, title, description snippet, tier badge, lesson count
- Filter by category (sidebar or dropdown)
- Filter by tier (All/Free/Pro/Ultra)
- Search by title
- CTA: "View Course" → `/courses/[slug]`

**Component:** `components/CourseCard.tsx`

- Reusable card for course display
- Shows tier badge, completion status (if user enrolled)
- Locked icon if user tier insufficient

### 4.3 Build Student View Components (YOU-165)

**Core components using `useDocument`:**

**`components/student/CourseView.tsx`**

- Main wrapper for course viewing experience
- Loads course with `useDocument(courseId)`
- Manages current lesson state
- Handles navigation between lessons

**`components/student/CourseSidebar.tsx`**

- Displays course structure (modules → lessons)
- Shows completion checkmarks for completed items
- Highlights current lesson
- Click lesson → navigate to that lesson
- Shows locked icon for lessons requiring upgrade

**`components/student/LessonContent.tsx`**

- Displays lesson title, description
- Renders rich text content
- Shows "Mark as Complete" button

**`components/student/ProgressTracker.tsx`**

- Calculate and display progress percentage
- Progress bar visual
- Stats: X of Y lessons completed

**Helper:** `lib/completion-helpers.ts`

```typescript
// Check if user completed a lesson
function hasCompletedLesson(lesson: Lesson, userId: string): boolean {
  return lesson.completedBy?.includes(userId) ?? false
}

// Calculate course progress
function calculateCourseProgress(course: Course, userId: string): number {
  // Check all lessons across all modules
  // Return percentage
}
```

### 4.4 Course View Page (YOU-167)

**File:** `app/courses/[slug]/page.tsx`

Layout:

- Left sidebar (fixed): `CourseSidebar` - module/lesson tree
- Main content area: Video player + lesson content
- Top bar: Course title, progress, back button

Functionality:

- Load course by slug
- Get current lesson from URL query param: `/courses/[slug]?lesson=[lessonId]`
- Check user tier vs. course tier → show upgrade prompt if needed
- Pass lesson data to video player and content components

### 4.5 Mux Video Player (YOU-169)

**Component:** `components/student/MuxVideoPlayer.tsx`

Use `@mux/mux-player-react`:

```typescript
import MuxPlayer from '@mux/mux-player-react'

<MuxPlayer
  playbackId={lesson.video.asset.playbackId}
  metadata={{
    video_title: lesson.title,
    viewer_user_id: userId
  }}
  streamType="on-demand"
  autoPlay={false}
/>
```

Features:

- Display video with Mux controls
- Show loading state
- Handle errors gracefully
- Optionally track watch time
- Auto-advance to next lesson toggle

### 4.6 Mark Lesson Complete (YOU-168)

**Component:** `components/student/LessonCompleteButton.tsx`

Functionality:

1. Get current user ID from Clerk
2. Check if user already completed lesson
3. Button states:

   - "Mark as Complete" (not completed)
   - "Mark as Incomplete" (already completed)

4. On click:

   - Use Sanity client to patch lesson document
   - Add/remove user ID from `completedBy[]` array
   - Optimistically update UI
   - Show success toast

5. Check if module/course now complete → show celebration

**Code pattern:**

```typescript
const toggleComplete = async () => {
  const userId = user.id // from Clerk
  
  if (isCompleted) {
    // Remove from array
    await client
      .patch(lessonId)
      .unset([`completedBy[@ == "${userId}"]`])
      .commit()
  } else {
    // Add to array
    await client
      .patch(lessonId)
      .setIfMissing({ completedBy: [] })
      .append('completedBy', [userId])
      .commit()
  }
}
```

**Deliverable:** Complete student learning experience with video playback and progress tracking

---

## Phase 5: Access Control & Billing (Weeks 9-10)

### 5.1 Clerk Billing Setup (YOU-177 - Part 2)

**Implementation:**

- Set up Stripe (or other payment provider)
- Create pricing plans matching tiers (free/pro/ultra)
- Create Clerk webhook handler: `app/api/webhooks/clerk/route.ts`
- On subscription change → update Clerk user metadata: `publicMetadata.tier`
- Create Stripe webhook handler (if using Stripe): `app/api/webhooks/stripe/route.ts`

**Helper functions:** `lib/billing-helpers.ts`

```typescript
export function getUserTier(user: User): 'free' | 'pro' | 'ultra' {
  return user.publicMetadata?.tier ?? 'free'
}

export function canAccessTier(userTier: string, requiredTier: string): boolean {
  const hierarchy = { free: 0, pro: 1, ultra: 2 }
  return hierarchy[userTier] >= hierarchy[requiredTier]
}
```

### 5.2 Upgrade Page (YOU-170)

**File:** `app/upgrade/page.tsx`

Design:

- Hero: "Unlock Your Learning Potential"
- Three-column pricing comparison (Free/Pro/Ultra)
- Feature comparison table
- FAQ section
- Current tier highlighted

Use Shadcn: Card, Badge, Button, Separator

**Features per tier (example):**

- **Free**: Access to free courses only
- **Pro**: Access to all Pro courses + free courses
- **Ultra**: Access to all courses + AI tutor chat

CTAs:

- Free: "Current Plan" or "Downgrade"
- Pro/Ultra: "Upgrade Now" → Stripe Checkout or payment flow

### 5.3 Gate Courses Based on Tier (YOU-178)

**Component:** `components/AccessGate.tsx`

Usage:

```tsx
<AccessGate
  requiredTier={course.tier}
  fallback={<UpgradePrompt requiredTier={course.tier} />}
>
  <CourseView course={course} />
</AccessGate>
```

Logic:

1. Get user from Clerk
2. Get user's tier from metadata
3. Compare with required tier
4. If insufficient → show upgrade prompt
5. If sufficient → render children

**Component:** `components/UpgradePrompt.tsx`

- Shows locked icon
- "This course requires [Pro/Ultra] access"
- "Upgrade Now" button → `/upgrade`
- List benefits of upgrading

**Apply to:**

- Course view page
- Lesson view (check course tier)
- Course list (show locked badge)

### 5.4 Gate AgentKit Chat (YOU-179)

**Component:** `components/AgentKitAccessGate.tsx`

Same pattern as course gating, but specifically for Ultra tier only.

Apply to AgentKit chat interface.

**Deliverable:** Full subscription management and tier-based access control

---

## Phase 6: Advanced Features (Weeks 11-12)

### 6.1 Add AgentKit with Sanity MCP (YOU-171)

**Setup:**

- Install AgentKit SDK
- Configure Sanity MCP server connection
- Set up OpenAI/Anthropic API keys

**Files:**

- `app/api/agentkit/chat/route.ts` - Chat API endpoint
- `components/agentkit/ChatInterface.tsx` - Chat UI
- `components/agentkit/ChatMessage.tsx` - Message component
- `lib/agentkit-config.ts` - AgentKit configuration

**Features:**

- Floating chat button (bottom right, only for Ultra users)
- Chat modal with message history
- AI can answer questions about:
  - Course content (via Sanity MCP)
  - Learning recommendations
  - Code help (if applicable)
  - Study strategies
- Context: Current course, lesson, user progress

**Context for AI:**

```typescript
const context = {
  currentCourse: course,
  currentLesson: lesson,
  userProgress: calculateProgress(),
  completedLessons: getCompletedLessons()
}
```

Gate this entire feature behind `tier === 'ultra'` check.

**Deliverable:** AI-powered learning assistant for Ultra users

---

## Phase 7: Testing & Polish (Week 13)

### 7.1 Validation & Type Safety

Run all validation scripts:

```bash
npm run typecheck
npm run typegen  
npm run build
```

Fix any TypeScript errors or schema issues.

### 7.2 User Flow Testing

**Admin flows:**

1. Create new course → add modules → add lessons → upload videos → publish
2. Reorder modules and lessons
3. Edit existing content
4. Unpublish/delete content

**Student flows:**

1. Browse courses → filter by category/tier
2. View course details → check if accessible
3. Watch lesson video → mark complete
4. Track progress across multiple courses
5. Attempt to access gated content → see upgrade prompt
6. Upgrade tier → access previously locked content

**Billing flows:**

1. Click upgrade → see pricing
2. Select tier → complete payment
3. Verify tier update in Clerk
4. Verify access to new content

### 7.3 UI/UX Polish

**Implement throughout:**

- Loading skeletons for async content
- Error boundaries for graceful errors
- Toast notifications for actions (saved, completed, etc.)
- Smooth transitions and animations
- Responsive design (mobile, tablet, desktop)
- Empty states ("No courses yet", "No lessons in this module")
- Confirmation dialogs for destructive actions

**Use Shadcn components:**

- Skeleton for loading states
- Toast for notifications
- Dialog for confirmations
- Alert for warnings/errors
- Progress for completion tracking

### 7.4 Performance Optimization

- Image optimization with Next.js Image component
- Lazy load video player
- Prefetch course data on hover
- Cache Sanity queries where appropriate
- Minimize client bundle size

---

## Build Order Summary

1. **Weeks 1-2:** Schema (references + completedBy arrays) + Clerk + Mux (YOU-163, YOU-177-1, YOU-175-1)
2. **Weeks 3-4:** Admin infrastructure with App SDK components (YOU-164, YOU-172)
3. **Weeks 5-6:** Admin content management for courses/modules/lessons + video upload (YOU-173-1, YOU-174, YOU-176, YOU-175-2)
4. **Weeks 7-8:** Student experience with course viewing and progress tracking (YOU-162, YOU-165, YOU-166, YOU-167, YOU-168, YOU-169, YOU-173-2)
5. **Weeks 9-10:** Billing system and tier-based access gating (YOU-177-2, YOU-170, YOU-178, YOU-179)
6. **Weeks 11-12:** AgentKit AI assistant (YOU-171)
7. **Week 13:** Testing, polish, and deployment prep

This approach builds from the data layer up, ensures you can create real content early, and validates the student experience with real data before adding monetization and AI features.

### To-dos

- [ ] Create all Sanity schema types (course, lesson, module, instructor, category, userProgress, subscriptionTier)
- [ ] Install and configure Clerk authentication with user metadata for tiers
- [ ] Install and configure Mux video integration with Sanity
- [ ] Build reusable AdminDocumentEditor component using useDocument hook
- [ ] Create all specialized admin input components (text, rich text, reference, image, array, select, Mux video)
- [ ] Set up admin routes, layout, and navigation with role-based access
- [ ] Build admin course list view with management features
- [ ] Implement create new course button and flow
- [ ] Build course editor with tabs for basic info, modules, pricing, and settings
- [ ] Implement Mux video upload and management in lesson editor
- [ ] Create student landing page with hero, featured courses, and categories
- [ ] Adapt CourseList component for student view with filtering and tier badges
- [ ] Build core student view components (course view, sidebar, lesson content, progress tracker)
- [ ] Create main course viewing page with video player and navigation
- [ ] Implement Mux video player component with controls and progress tracking
- [ ] Build mark lesson as completed functionality with progress updates
- [ ] Set up Clerk billing webhooks and tier management system
- [ ] Create upgrade page with pricing tiers and payment integration
- [ ] Implement course access gating based on user subscription tier
- [ ] Gate AgentKit chat feature for Ultra tier users only
- [ ] Integrate AgentKit with Sanity MCP for AI-powered learning assistant