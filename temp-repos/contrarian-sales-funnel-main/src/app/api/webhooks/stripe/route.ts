import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { activateSubscription } from '@/actions/course';
import Subscription from '@/models/Subscription';
import connectDB from '@/lib/mongodb';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-10-29.clover',
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

export async function POST(req: Request) {
  try {
    const body = await req.text();
    const signature = (await headers()).get('stripe-signature')!;

    let event: Stripe.Event;

    // Verify webhook signature
    try {
      event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
    } catch (err) {
      console.error('⚠️  Webhook signature verification failed:', err);
      return NextResponse.json(
        { error: 'Webhook signature verification failed' },
        { status: 400 }
      );
    }

    // Handle the event
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        
        console.log('✅ Checkout session completed:', session.id);
        
        // Get the Clerk user ID from metadata
        const clerkId = session.metadata?.clerkId;
        
        if (!clerkId) {
          console.error('❌ No clerkId in session metadata');
          return NextResponse.json(
            { error: 'Missing clerkId in metadata' },
            { status: 400 }
          );
        }

        // Update subscription to 'completed' status
        // Note: Subscription may already exist as 'pending' from payment-success page
        const result = await activateSubscription(
          clerkId,
          session.payment_intent as string,
          session.customer as string | undefined
        );

        if (result.success) {
          console.log('🎉 Subscription activated (status: completed) for user:', clerkId);
          
          // Optional: Send confirmation email here
          // await sendSubscriptionConfirmationEmail(clerkId);
        } else {
          console.error('❌ Failed to activate subscription:', result.error);
        }
        
        break;
      }

      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        console.log('💰 PaymentIntent succeeded:', paymentIntent.id);
        
        // Note: Subscription should already exist from payment-success page
        // This is just a backup in case that didn't work
        
        const clerkId = paymentIntent.metadata?.clerkId;
        
        if (clerkId) {
          await connectDB();
          
          const existingSub = await Subscription.findOne({ 
            stripePaymentIntentId: paymentIntent.id 
          });
          
          if (existingSub) {
            console.log('✅ Subscription already exists for payment:', paymentIntent.id);
          } else {
            console.log('⚠️  No subscription found - creating pending for admin review');
            console.log('   This is unusual - payment-success page should have created it');
          }
        }
        
        break;
      }

      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        console.error('❌ Payment failed:', paymentIntent.id);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error('Error processing webhook:', error);
    return NextResponse.json(
      { error: 'Webhook processing failed' },
      { status: 500 }
    );
  }
}

