import { headers } from 'next/headers';
import { Webhook } from 'svix';
import { WebhookEvent } from '@clerk/nextjs/server';
import connectDB from '@/lib/mongodb';
import User from '@/models/User';

export async function POST(req: Request) {
  console.log('🔔 Webhook received at /api/webhooks/clerk');
  
  // Get the headers
  const headerPayload = await headers();
  const svix_id = headerPayload.get('svix-id');
  const svix_timestamp = headerPayload.get('svix-timestamp');
  const svix_signature = headerPayload.get('svix-signature');

  console.log('📝 Headers:', { svix_id, svix_timestamp, has_signature: !!svix_signature });

  // If there are no headers, error out
  if (!svix_id || !svix_timestamp || !svix_signature) {
    console.error('❌ Missing svix headers');
    return new Response('Error occurred -- no svix headers', {
      status: 400,
    });
  }

  // Get the body
  const payload = await req.json();
  const body = JSON.stringify(payload);
  
  console.log('📦 Payload type:', payload.type);

  // Create a new Svix instance with your secret
  const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
  
  if (!webhookSecret) {
    console.error('❌ CLERK_WEBHOOK_SECRET is not set in environment variables');
    return new Response('Webhook secret not configured', { status: 500 });
  }
  
  console.log('🔐 Webhook secret found');
  const wh = new Webhook(webhookSecret);

  let evt: WebhookEvent;

  // Verify the payload with the headers
  try {
    evt = wh.verify(body, {
      'svix-id': svix_id,
      'svix-timestamp': svix_timestamp,
      'svix-signature': svix_signature,
    }) as WebhookEvent;
    console.log('✅ Webhook signature verified');
  } catch (err) {
    console.error('❌ Error verifying webhook:', err);
    return new Response('Error occurred', {
      status: 400,
    });
  }

  // Handle the webhook
  const eventType = evt.type;
  console.log('🎯 Event type:', eventType);

  if (eventType === 'user.created' || eventType === 'user.updated') {
    const { id, email_addresses, first_name, last_name, image_url } = evt.data;
    
    console.log('👤 User data:', {
      id,
      email: email_addresses[0]?.email_address,
      first_name,
      last_name,
    });

    try {
      console.log('🔌 Connecting to MongoDB...');
      await connectDB();
      console.log('✅ MongoDB connected');

      // Upsert user (create or update)
      const user = await User.findOneAndUpdate(
        { clerkId: id },
        {
          clerkId: id,
          email: email_addresses[0]?.email_address,
          firstName: first_name,
          lastName: last_name,
          imageUrl: image_url,
        },
        { upsert: true, new: true }
      );

      console.log(`✅ User ${eventType}: ${id}`);
      console.log('💾 Saved user:', user);
    } catch (error) {
      console.error(`❌ Error syncing user to database:`, error);
      return new Response('Error syncing user', { status: 500 });
    }
  } else {
    console.log('ℹ️ Ignoring event type:', eventType);
  }

  return new Response('Webhook received', { status: 200 });
}

