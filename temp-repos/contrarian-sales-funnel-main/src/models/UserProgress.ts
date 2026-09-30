import mongoose, { Document, Model, Schema } from 'mongoose';

// Lesson progress interface
export interface ILessonProgress {
  lessonId: string;
  completed: boolean;
  completedAt?: Date;
  lastWatchedPosition?: number; // in seconds for video tracking
  timeSpent?: number; // in seconds
}

// Module progress interface
export interface IModuleProgress {
  moduleId: string;
  completed: boolean;
  completedAt?: Date;
  lessons: ILessonProgress[];
  progress: number; // 0-100 percentage
}

// User course progress interface
export interface IUserProgress extends Document {
  userId: string;
  clerkId: string;
  courseId: string;
  
  // Overall progress
  overallProgress: number; // 0-100 percentage
  isCompleted: boolean;
  completedAt?: Date;
  
  // Enrollment
  enrolledAt: Date;
  lastAccessedAt: Date;
  
  // Module & Lesson tracking
  modules: IModuleProgress[];
  
  // Stats
  totalTimeSpent: number; // in seconds
  currentModuleId?: string;
  currentLessonId?: string;
  
  // Certificate
  certificateIssued: boolean;
  certificateUrl?: string;
  certificateIssuedAt?: Date;
  
  // Notes (optional feature)
  notes?: {
    lessonId: string;
    content: string;
    createdAt: Date;
  }[];
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  
  // Methods
  calculateProgress(): void;
  completeLesson(moduleId: string, lessonId: string): void;
  updateLastAccessed(): void;
}

const LessonProgressSchema = new Schema({
  lessonId: {
    type: String,
    required: true,
  },
  completed: {
    type: Boolean,
    default: false,
  },
  completedAt: {
    type: Date,
  },
  lastWatchedPosition: {
    type: Number,
    default: 0,
  },
  timeSpent: {
    type: Number,
    default: 0,
  },
});

const ModuleProgressSchema = new Schema({
  moduleId: {
    type: String,
    required: true,
  },
  completed: {
    type: Boolean,
    default: false,
  },
  completedAt: {
    type: Date,
  },
  lessons: [LessonProgressSchema],
  progress: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
});

const UserProgressSchema: Schema<IUserProgress> = new Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    clerkId: {
      type: String,
      required: true,
      index: true,
    },
    courseId: {
      type: String,
      required: true,
      index: true,
    },
    overallProgress: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    isCompleted: {
      type: Boolean,
      default: false,
    },
    completedAt: {
      type: Date,
    },
    enrolledAt: {
      type: Date,
      default: Date.now,
    },
    lastAccessedAt: {
      type: Date,
      default: Date.now,
    },
    modules: [ModuleProgressSchema],
    totalTimeSpent: {
      type: Number,
      default: 0,
    },
    currentModuleId: {
      type: String,
    },
    currentLessonId: {
      type: String,
    },
    certificateIssued: {
      type: Boolean,
      default: false,
    },
    certificateUrl: {
      type: String,
    },
    certificateIssuedAt: {
      type: Date,
    },
    notes: [{
      lessonId: String,
      content: String,
      createdAt: {
        type: Date,
        default: Date.now,
      },
    }],
  },
  {
    timestamps: true,
  }
);

// Compound indexes for efficient queries
UserProgressSchema.index({ userId: 1, courseId: 1 }, { unique: true });
UserProgressSchema.index({ clerkId: 1, courseId: 1 });
UserProgressSchema.index({ userId: 1, isCompleted: 1 });
UserProgressSchema.index({ lastAccessedAt: -1 });

// Method to calculate overall progress
UserProgressSchema.methods.calculateProgress = function() {
  if (!this.modules || this.modules.length === 0) {
    this.overallProgress = 0;
    return;
  }
  
  let totalLessons = 0;
  let completedLessons = 0;
  
  this.modules.forEach((module: IModuleProgress) => {
    module.lessons.forEach((lesson: ILessonProgress) => {
      totalLessons++;
      if (lesson.completed) {
        completedLessons++;
      }
    });
  });
  
  this.overallProgress = totalLessons > 0 
    ? Math.round((completedLessons / totalLessons) * 100) 
    : 0;
  
  // Check if course is completed
  if (this.overallProgress === 100 && !this.isCompleted) {
    this.isCompleted = true;
    this.completedAt = new Date();
  }
};

// Method to mark a lesson as completed
UserProgressSchema.methods.completeLesson = function(moduleId: string, lessonId: string) {
  const module = this.modules.find((m: IModuleProgress) => m.moduleId === moduleId);
  
  if (module) {
    const lesson = module.lessons.find((l: ILessonProgress) => l.lessonId === lessonId);
    
    if (lesson && !lesson.completed) {
      lesson.completed = true;
      lesson.completedAt = new Date();
      
      // Calculate module progress
      const totalLessons = module.lessons.length;
      const completedLessons = module.lessons.filter((l: ILessonProgress) => l.completed).length;
      module.progress = Math.round((completedLessons / totalLessons) * 100);
      
      // Check if module is completed
      if (module.progress === 100 && !module.completed) {
        module.completed = true;
        module.completedAt = new Date();
      }
      
      // Recalculate overall progress
      this.calculateProgress();
    }
  }
};

// Method to update last accessed time
UserProgressSchema.methods.updateLastAccessed = function() {
  this.lastAccessedAt = new Date();
};

// Pre-save hook
UserProgressSchema.pre('save', function(next) {
  if (this.isModified('modules')) {
    this.calculateProgress();
  }
  next();
});

// Prevent model overwrite upon initial compile
const UserProgress: Model<IUserProgress> =
  mongoose.models.UserProgress || 
  mongoose.model<IUserProgress>('UserProgress', UserProgressSchema);

export default UserProgress;

