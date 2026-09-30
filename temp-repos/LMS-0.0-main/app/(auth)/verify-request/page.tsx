"use client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import React, { Suspense, useEffect, useState, useTransition } from "react";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { Button } from "@/components/ui/button";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

export default function VerifyRequestRoute(){
  return (
    <Suspense>
      <VerifyRequest />
    </Suspense>
  )
}

function VerifyRequest() {
  const [otp, setOtp] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const params = useSearchParams();
  const isOtpCompleted = otp.length === 6;

  const email = params.get("email") ?? "";

  //cooldown effect
  useEffect(() => {
    if (cooldown > 0) {
      const timer = setInterval(() => setCooldown((prev) => prev - 1), 1000);
      return () => clearInterval(timer);
    }
  }, [cooldown]);

  function verifyAccount() {
    startTransition(async () => {
      await authClient.signIn.emailOtp({
        email: email, // required
        otp: otp, // required
        fetchOptions: {
          onSuccess: () => {
            toast.success("Your account is verified");
            router.push("/");
          },
          onError: () => {
            toast.error("Error occurred while verifying the account");
          },
        },
      });
    });
  }

  function handleResendOTP() {
    startTransition(async () => {
      if (!email) {
        toast.error("Missing email parameter");
        return;
      }
      await authClient.emailOtp.sendVerificationOtp({
        email: email, // required
        type: "sign-in", // required
        fetchOptions: {
          onSuccess: () => {
            toast.success("A new OTP has been sent to your email.");
            setCooldown(30); // 30s lockout
          },

          onError: () => {
            toast.error("Failed to resend OTP. Please try again.");
          },
        },
      });
    });
  }

  return (
    <Card className="w-full max-w-md mx-auto shadow-lg rounded-2xl bg-card">
      <CardHeader className="space-y-3 text-center">
        <CardTitle className="text-2xl font-bold tracking-tight">
          Please Verify Your Account
        </CardTitle>
        <CardDescription className="text-sm leading-relaxed text-muted-foreground">
          Enter the 6-digit code we sent to your email address
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col items-center space-y-6">
        {/* OTP Input */}
        <InputOTP value={otp} onChange={(value) => setOtp(value)} maxLength={6}>
          <InputOTPGroup className="gap-2">
            <InputOTPSlot index={0} className="h-12 w-12 rounded-lg" />
            <InputOTPSlot index={1} className="h-12 w-12 rounded-lg" />
            <InputOTPSlot index={2} className="h-12 w-12 rounded-lg" />
          </InputOTPGroup>
          <InputOTPSeparator />
          <InputOTPGroup className="gap-2">
            <InputOTPSlot index={3} className="h-12 w-12 rounded-lg" />
            <InputOTPSlot index={4} className="h-12 w-12 rounded-lg" />
            <InputOTPSlot index={5} className="h-12 w-12 rounded-lg" />
          </InputOTPGroup>
        </InputOTP>
        <Button onClick={verifyAccount} disabled={pending || !isOtpCompleted}>
          {" "}
          {pending ? (
            <>
              <Loader2 className="animate-spin" />
              <span>Loading...</span>
            </>
          ) : (
            <>Verify Account</>
          )}
        </Button>
        {/* Resend / Actions */}
        <div className="flex flex-col items-center space-y-2 text-sm">
          <p className="text-muted-foreground">Didn’t receive the code?</p>
          <Button
            disabled={cooldown > 0}
            onClick={handleResendOTP}
            variant="link"
            className="text-primary px-0 h-auto"
          >
            {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend OTP"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};


