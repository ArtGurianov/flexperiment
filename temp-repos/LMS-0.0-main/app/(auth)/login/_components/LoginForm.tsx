"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { GithubIcon, Loader2, Send } from "lucide-react";
import { useRouter } from "next/navigation";

import { useState, useTransition } from "react";
import { toast } from "sonner";

const LoginForm = () => {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState("");

  async function signInWithGitHub() {
    startTransition(async () => {
      await authClient.signIn.social({
        provider: "github",
        callbackURL: "/",
        fetchOptions: {
          onSuccess: () => {
            toast.success("Successfully signed in with GitHub!");
          },
          onError: ({ error }) => {
            console.error("GitHub sign-in error:", error);
            toast.error(`Error signing in with GitHub: ${error.message}`);
          },
        },
      });
    });
  }

  function signInWithEmail() {
    startTransition(async () => {
      await authClient.emailOtp.sendVerificationOtp({
        email: email, // required
        type: "sign-in", // required
        fetchOptions: {
          onSuccess: () => {
            toast.success("OTP has been sent to your email address. Please verify your email.");
            router.push(`/verify-request?email=${email}`);
          },

          onError: () => {
            toast.error("Error occurred while sending the OTP to your email.");
          },
        },
      });
    });
  }

  return (
    <Card className="shadow-xl border rounded-2xl w-full max-w-md mx-auto bg-card">
      <CardHeader className="space-y-4 text-center">
        <CardTitle className="text-2xl font-bold tracking-tight">Welcome Back 👋</CardTitle>
        <CardDescription className="leading-relaxed text-sm">
          Sign in with your GitHub account or email to continue
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-8">
        {/* GitHub Login */}
        <Button
          disabled={pending}
          onClick={signInWithGitHub}
          type="button"
          variant="outline"
          className="w-full flex items-center justify-center gap-2 py-6 cursor-pointer bg-transparent"
        >
          {pending ? (
            <>
              <Loader2 className="animate-spin" />
              <span>Loading...</span>
            </>
          ) : (
            <>
              <GithubIcon className="h-5 w-5" />
              Continue with GitHub
            </>
          )}
        </Button>

        {/* Separator */}
        <div className="relative my-8">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-muted" />
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="bg-card px-4 py-1 rounded-full text-muted-foreground">
              Or continue with
            </span>
          </div>
        </div>

        {/* Email Login */}
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="email" className="text-sm font-medium">
              Email
            </Label>
            <Input
              id="email"
              type="email"
              placeholder="moh@gmail.com"
              className="h-11"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <Button disabled={pending} onClick={signInWithEmail} className="w-full py-6">
            {pending ? (
              <>
                <Loader2 className="animate-spin" />
                <span>Loading...</span>
              </>
            ) : (
              <>
                <Send />
                <span>Continue with Email</span>
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

export default LoginForm;
