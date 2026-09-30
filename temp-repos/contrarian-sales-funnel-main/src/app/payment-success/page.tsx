'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { ensureSubscriptionFromSession } from '@/actions/subscription';
import { useUser } from '@clerk/nextjs';

function PaymentSuccessContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const [status, setStatus] = useState<'checking' | 'completed' | 'pending' | 'error'>('checking');
  const [sessionData, setSessionData] = useState<{
    amount: string;
    transactionId: string;
    date: string;
  }>({
    amount: '$99.00',
    transactionId: 'TXN123456789',
    date: new Date().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
  });

  useEffect(() => {
    const sessionId = searchParams.get('session_id');
    
    // Wait for Clerk to finish loading before checking user
    if (!isLoaded) {
      return;
    }
    
    if (!sessionId || !user) {
      setStatus('error');
      return;
    }

    const verifyPayment = async () => {
      // Step 1: Immediately create/ensure subscription record from Stripe session
      const result = await ensureSubscriptionFromSession(sessionId);
      
      if (!result.success) {
        setStatus('error');
        return;
      }
      
      // Update transaction ID from session
      setSessionData(prev => ({
        ...prev,
        transactionId: sessionId.substring(0, 16).toUpperCase()
      }));
      
      // Step 2: Check the status
      if (result.status === 'completed') {
        setStatus('completed');
      } else if (result.status === 'pending') {
        setStatus('pending');
      } else {
        setStatus('error');
      }
    };

    verifyPayment();
  }, [searchParams, user, router, isLoaded]);

  if (status === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f5f5f5] px-4">
        <div className="w-full max-w-[580px] bg-white rounded-2xl shadow-lg p-12 text-center">
          <div className="w-16 h-16 border-4 border-green-500 border-t-transparent rounded-full animate-spin mx-auto mb-6"></div>
          <p className="text-gray-600 text-lg">Verifying payment...</p>
        </div>
      </div>
    );
  }

  if (status === 'completed' || status === 'pending') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f5f5f5] px-4">
        <div className="w-full max-w-[580px] bg-white rounded-2xl shadow-lg p-12">
          {/* Success Icon */}
          <div className="w-24 h-24 bg-green-500 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-14 h-14 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          </div>

          {/* Title */}
          <h1 className="text-3xl font-bold text-gray-900 mb-4 text-center pb-2">Payment Successful!</h1>
          
          {/* Message */}
          <p className="text-gray-600 text-center mb-8 pb-4">
            Thank you for your payment. Your transaction has been completed successfully.
          </p>

          {/* Transaction Details */}
          <div className="bg-gray-50 rounded-lg p-6 mb-8 space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-gray-600">Amount Paid</span>
              <span className="text-gray-900 font-semibold">{sessionData.amount}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">Transaction ID</span>
              <span className="text-gray-900 font-semibold text-sm">{sessionData.transactionId}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">Date</span>
              <span className="text-gray-900 font-semibold">{sessionData.date}</span>
            </div>
            {status === 'pending' && (
              <div className="flex justify-between items-center">
                <span className="text-gray-600">Status</span>
                <span className="text-orange-500 font-semibold">Payment Pending!  Reviewing your payment.</span>
              </div>
            )}
          </div>

          {/* CTA Button */}
          <button
            onClick={() => router.push('/dashboard')}
            className="w-full px-6 py-4 bg-green-500 hover:bg-green-600 text-white font-semibold rounded-lg transition-colors duration-200"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f5f5f5] px-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-lg p-12">
        {/* Error Icon */}
        <div className="w-24 h-24 bg-red-500 rounded-full flex items-center justify-center mx-auto mb-6">
          <svg className="w-14 h-14 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>

        {/* Title */}
        <h1 className="text-3xl font-bold text-gray-900 mb-4 text-center">Payment Error</h1>
        
        {/* Message */}
        <p className="text-gray-600 text-center mb-8">
          We couldn&apos;t verify your payment. If your card was charged, please contact our support team.
        </p>

        {/* Support Info */}
        <div className="bg-gray-50 rounded-lg p-6 mb-8">
          <div className="text-center">
            <p className="text-gray-600 mb-2">Contact Support</p>
            <a 
              href="mailto:support@example.com" 
              className="text-green-500 hover:text-green-600 font-semibold text-lg transition-colors duration-200"
            >
              support@example.com
            </a>
          </div>
        </div>

        {/* CTA Button */}
        <button
          onClick={() => router.push('/')}
          className="w-full px-6 py-4 bg-green-500 hover:bg-green-600 text-white font-semibold rounded-lg transition-colors duration-200"
        >
          Back to Homepage
        </button>
      </div>
    </div>
  );
}

export default function PaymentSuccessPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-[#f5f5f5] px-4">
          <div className="w-full max-w-[580px] bg-white rounded-2xl shadow-lg p-12 text-center">
            <div className="w-16 h-16 border-4 border-green-500 border-t-transparent rounded-full animate-spin mx-auto mb-6"></div>
            <p className="text-gray-600 text-lg">Loading...</p>
          </div>
        </div>
      }
    >
      <PaymentSuccessContent />
    </Suspense>
  );
}
