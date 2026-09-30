import mongoose, { Document, Model, Schema } from 'mongoose';

export interface ISubscription extends Document {
  userId: string;
  clerkId: string;
  
  // Subscription details
  status: 'completed' | 'pending' | 'failed';
  
  amount: number;
  currency: string;
  stripePaymentIntentId: string; 
  stripeCustomerId?: string;
  
  // Dates
  purchaseDate: Date;
  activatedAt?: Date;
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  
  // Methods
  activate(): void;
  isActive(): boolean;
}

const SubscriptionSchema: Schema<ISubscription> = new Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    clerkId: {
      type: String,
      required: true,
      unique: true, // One subscription per user
      index: true,
    },
    status: {
      type: String,
      enum: ['completed', 'pending', 'failed'],
      default: 'pending',
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      default: 99, // $99 one-time payment
    },
    currency: {
      type: String,
      default: 'USD',
    },
    stripePaymentIntentId: {
      type: String,
      required: true,
      unique: true, // Prevents duplicate payments
      index: true,
    },
    stripeCustomerId: {
      type: String,
      index: true,
    },
    purchaseDate: {
      type: Date,
      default: Date.now,
    },
    activatedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for quick subscription lookups
SubscriptionSchema.index({ clerkId: 1, status: 1 });

// Method to mark payment as completed
SubscriptionSchema.methods.activate = function() {
  this.status = 'completed';
  this.activatedAt = new Date();
};

// Method to check if subscription is completed (has access)
// Access is determined ONLY by status, not a separate field
SubscriptionSchema.methods.isActive = function(): boolean {
  return this.status === 'completed';
};

// Prevent model overwrite upon initial compile
const Subscription: Model<ISubscription> =
  mongoose.models.Subscription || 
  mongoose.model<ISubscription>('Subscription', SubscriptionSchema);

export default Subscription;

