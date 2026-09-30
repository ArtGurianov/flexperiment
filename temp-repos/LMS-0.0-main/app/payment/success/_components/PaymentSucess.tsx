"use client";

import { Card } from "@/components/ui/card";
import { useConfetti } from "@/hooks/use.confetti";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import React, { useEffect } from "react";

interface PaymentSuccessProps {
  enrollmentId: string;
}

const PaymentSuccess = ({ enrollmentId }: PaymentSuccessProps) => {
  const { triggerConfetti } = useConfetti();

  useEffect(() => {
    triggerConfetti();

    if (enrollmentId) {
      fetch("/api/enrollment/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enrollmentId }),
      })
        .then(res => res.json())
        .then(data => console.log(data))
        .catch(err => console.error(err));
    }
  }, [triggerConfetti, enrollmentId]);

  return (
    <div className="w-full min-h-screen flex items-center justify-center px-4 bg-gradient-to-b from-green-50 to-white dark:from-gray-900 dark:to-black">
      <Card className="w-full max-w-sm p-6 text-center space-y-6 shadow-lg border-green-200">
        <div className="flex justify-center">
          <CheckCircle2 className="size-14 text-green-600" />
        </div>

        <div className="space-y-2">
          <h2 className="text-2xl font-bold text-green-700">Payment Successful 🎉</h2>
          <p className="text-sm text-muted-foreground">
            Thank you for your purchase! You now have full access to the course.
          </p>
        </div>

        <Link
          href="/dashboard"
          className="inline-flex items-center justify-center gap-2 rounded-md bg-green-600 text-white px-4 py-2 text-sm font-medium shadow hover:bg-green-700 transition"
        >
          <ArrowLeft className="h-4 w-4" />
          Continue to Dashboard
        </Link>

        <p className="text-xs text-muted-foreground">Enjoy your learning journey 🚀</p>
      </Card>
    </div>
  );
};

export default PaymentSuccess;
