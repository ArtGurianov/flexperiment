import { Card } from "@/components/ui/card";
import { ArrowLeft, XIcon } from "lucide-react";
import Link from "next/link";
import React from "react";

const PaymentCancel = () => {
  return (
    <div className="w-full min-h-screen flex items-center justify-center px-4">
      <Card className="w-full max-w-sm p-6 text-center space-y-4">
        {/* Icon */}
        <div className="flex justify-center">
          <XIcon className="size-12 p-2 bg-red-500/20 text-red-600 rounded-full" />
        </div>

        {/* Message */}
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Payment Cancelled</h2>
          <p className="text-sm text-muted-foreground">
            No worries, you won’t be charged.
          </p>
        </div>

        {/* Go Back Link */}
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm font-medium text-red-600 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />
          Go Back
        </Link>
      </Card>
    </div>
  );
};

export default PaymentCancel;
