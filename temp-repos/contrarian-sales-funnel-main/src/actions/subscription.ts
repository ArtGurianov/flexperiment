'use server';

import { currentUser } from '@clerk/nextjs/server';
import Stripe from 'stripe';
import { checkSubscription } from './course';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-10-29.clover',
});

/**
 * Create Stripe checkout session for $99 subscription
 */
export async function createCheckoutSession() {
  try {
    const user = await currentUser();

    if (!user) {
      return { 
        success: false, 
        error: 'You must be signed in to subscribe' 
      };
    }

    // Check if user already completed payment (better UX)
    const { isSubscribed } = await checkSubscription(user.id);
    if (isSubscribed) {
      return { 
        success: false, 
        error: 'You already have access to all courses' 
      };
    }

    const origin = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment', // One-time payment
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'All-Access Course Subscription',
              description: 'Lifetime access to all courses - One-time payment of $99',
            },
            unit_amount: 9900, // $99.00 in cents
          },
          quantity: 1,
        },
      ],
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/?cancelled=true`,
      customer_email: user.emailAddresses[0]?.emailAddress,
      metadata: {
        clerkId: user.id, // Important: Pass user ID for webhook
        userEmail: user.emailAddresses[0]?.emailAddress || '',
        userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      },
    });

    return {
      success: true,
      sessionId: session.id,
      url: session.url,
    };
  } catch (error) {
    console.error('Error creating checkout session:', error);
    return { 
      success: false, 
      error: 'Failed to create checkout session. Please try again.' 
    };
  }
}

/**
 * Get subscription status for current user
 */
export async function getMySubscription() {
  try {
    const user = await currentUser();

    if (!user) {
      return { 
        success: false, 
        isSubscribed: false,
        error: 'Not authenticated' 
      };
    }

    const result = await checkSubscription(user.id);
    
    return {
      success: true,
      isSubscribed: result.isSubscribed,
      subscription: result.subscription,
    };
  } catch (error) {
    console.error('Error fetching subscription:', error);
    return { 
      success: false, 
      isSubscribed: false,
      error: 'Failed to fetch subscription' 
    };
  }
}

/**
 * Create or update subscription after successful payment
 * This is called immediately when user lands on success page
 * Ensures subscription is saved even if webhook fails
 */
export async function ensureSubscriptionFromSession(sessionId: string) {
  try {
    // Verify the session with Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (session.payment_status !== 'paid') {
      return {
        success: false,
        status: 'unpaid',
        error: 'Payment not completed'
      };
    }
    
    // Payment was successful! Get user info from metadata
    const clerkId = session.metadata?.clerkId;
    
    if (!clerkId) {
      return {
        success: false,
        status: 'error',
        error: 'Missing user information'
      };
    }
    
    const connectDB = (await import('@/lib/mongodb')).default;
    const Subscription = (await import('@/models/Subscription')).default;
    
    await connectDB();
    
    const paymentIntentId = session.payment_intent as string;
    
    // Check if subscription already exists by payment ID
    let subscription = await Subscription.findOne({ 
      stripePaymentIntentId: paymentIntentId 
    });
    
    if (subscription) {
      // Subscription already exists (from webhook or previous page load)
      return {
        success: true,
        status: subscription.status, // 'completed' or 'pending'
        subscription: JSON.parse(JSON.stringify(subscription)),
        message: subscription.status === 'completed' 
          ? 'Subscription already activated'
          : 'Subscription pending admin review'
      };
    }
    
    // Check if user already has a subscription (different payment)
    subscription = await Subscription.findOne({ clerkId });
    
    if (subscription) {
      // User already subscribed with a different payment
      // Update with new payment info
      subscription.stripePaymentIntentId = paymentIntentId;
      subscription.status = 'pending'; // Reset to pending, webhook will complete
      subscription.amount = (session.amount_total || 9900) / 100;
      subscription.stripeCustomerId = session.customer as string | undefined;
      subscription.purchaseDate = new Date();
      await subscription.save();
      
      
      return {
        success: true,
        status: 'pending',
        subscription: JSON.parse(JSON.stringify(subscription)),
        message: 'Payment recorded. Waiting for confirmation...'
      };
    }
    
    // No existing subscription - create new one
    // Create with 'pending' status - webhook will update to 'completed' if it fires
    subscription = await Subscription.create({
      userId: clerkId,
      clerkId,
      status: 'pending', // Start as pending, webhook updates to completed
      amount: (session.amount_total || 9900) / 100,
      currency: (session.currency || 'usd').toUpperCase(),
      stripePaymentIntentId: paymentIntentId,
      stripeCustomerId: session.customer as string | undefined,
      purchaseDate: new Date(),
    });
    

    
    return {
      success: true,
      status: 'pending',
      subscription: JSON.parse(JSON.stringify(subscription)),
      message: 'Payment recorded. Waiting for confirmation...'
    };
    
  } catch (error) {
    console.error('Error ensuring subscription:', error);
    return {
      success: false,
      status: 'error',
      error: 'Failed to verify payment'
    };
  }
}

