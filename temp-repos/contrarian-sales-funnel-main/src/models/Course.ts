import mongoose, { Document, Model, Schema } from 'mongoose';

// Lesson interface
export interface ILesson {
  _id?: string;
  title: string;
  description?: string;
  videoUrl?: string;
  videoDuration?: number; // in seconds
  order: number;
  isFree?: boolean;
  resources?: {
    title: string;
    url: string;
    type: 'pdf' | 'doc' | 'video' | 'link' | 'other';
  }[];
}

// Module/Section interface
export interface IModule {
  _id?: string;
  title: string;
  description?: string;
  order: number;
  lessons: ILesson[];
}

// Course interface
export interface ICourse extends Document {
  title: string;
  slug: string;
  description: string;
  shortDescription?: string;
  
  // Content
  modules: IModule[];
  
  // Media
  thumbnail?: { public_id: string; url: string } | string | null;
  
  // Instructor
  instructor?: mongoose.Schema.Types.ObjectId;
  
  // Metadata
  category: string;
  tags?: string[];
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  language: string;
  
  // Duration & Stats
  totalDuration?: number; // in minutes
  totalLessons?: number;
  enrolledCount: number;
  completedCount: number;
  
  // Rating
  rating?: number;
  ratingCount?: number;
  
  // Pricing
  price?: number;
  currency?: string;
  isFree: boolean;
  
  // Status
  isPublished: boolean;
  isFeatured: boolean;
  
  // SEO
  metaTitle?: string;
  metaDescription?: string;
  
  // Learning Outcomes
  learningOutcomes?: string[];
  requirements?: string[];
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  publishedAt?: Date;
  
  // Methods
  calculateTotalDuration(): void;
}

const LessonSchema = new Schema({
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
  },
  videoUrl: {
    type: String,
  },
  videoDuration: {
    type: Number, // in seconds
  },
  order: {
    type: Number,
    required: true,
  },
  isFree: {
    type: Boolean,
    default: false,
  },
  resources: [{
    title: String,
    url: String,
    type: {
      type: String,
      enum: ['pdf', 'doc', 'video', 'link', 'other'],
    },
  }],
});

const ModuleSchema = new Schema({
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
  },
  order: {
    type: Number,
    required: true,
  },
  lessons: [LessonSchema],
});

const CourseSchema: Schema<ICourse> = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      index: true,
      lowercase: true,
    },
    description: {
      type: String,
      required: true,
    },
    shortDescription: {
      type: String,
    },
    modules: [ModuleSchema],
    // Allow legacy string or new object structure
    thumbnail: {
      type: Schema.Types.Mixed,
      default: null,
    },
    instructor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    category: {
      type: String,
      required: true,
      index: true,
    },
    tags: [{
      type: String,
    }],
    difficulty: {
      type: String,
      enum: ['beginner', 'intermediate', 'advanced'],
      default: 'beginner',
    },
    language: {
      type: String,
      default: 'en',
    },
    totalDuration: {
      type: Number, // in minutes
    },
    totalLessons: {
      type: Number,
    },
    enrolledCount: {
      type: Number,
      default: 0,
    },
    completedCount: {
      type: Number,
      default: 0,
    },
    rating: {
      type: Number,
      min: 0,
      max: 5,
    },
    ratingCount: {
      type: Number,
      default: 0,
    },
    price: {
      type: Number,
      min: 0,
    },
    currency: {
      type: String,
      default: 'USD',
    },
    isFree: {
      type: Boolean,
      default: false,
    },
    isPublished: {
      type: Boolean,
      default: false,
      index: true,
    },
    isFeatured: {
      type: Boolean,
      default: false,
      index: true,
    },
    metaTitle: {
      type: String,
    },
    metaDescription: {
      type: String,
    },
    learningOutcomes: [{
      type: String,
    }],
    requirements: [{
      type: String,
    }],
    publishedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for better query performance
CourseSchema.index({ category: 1, isPublished: 1 });
CourseSchema.index({ isFeatured: 1, isPublished: 1 });
CourseSchema.index({ createdAt: -1 });

// Virtual for calculating completion rate
CourseSchema.virtual('completionRate').get(function() {
  if (this.enrolledCount === 0) return 0;
  return (this.completedCount / this.enrolledCount) * 100;
});

// Method to calculate total duration from modules
CourseSchema.methods.calculateTotalDuration = function() {
  let totalSeconds = 0;
  let lessonCount = 0;
  
  this.modules.forEach((module: IModule) => {
    module.lessons.forEach((lesson: ILesson) => {
      if (lesson.videoDuration) {
        totalSeconds += lesson.videoDuration;
      }
      lessonCount++;
    });
  });
  
  this.totalDuration = Math.ceil(totalSeconds / 60); // Convert to minutes
  this.totalLessons = lessonCount;
};

// Pre-save hook to update totals
CourseSchema.pre('save', function(next) {
  if (this.isModified('modules')) {
    this.calculateTotalDuration();
  }
  next();
});

// Prevent model overwrite upon initial compile
const Course: Model<ICourse> =
  mongoose.models.Course || mongoose.model<ICourse>('Course', CourseSchema);

export default Course;

