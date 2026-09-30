// AuthLayout.tsx
import { buttonVariants } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import React from "react";

const AuthLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground px-4 sm:px-6 lg:px-8">
      {/* Back Button */}
      <div className="absolute top-6 left-6">
        <Link
          href="/"
          className={buttonVariants({
            variant: "outline",
          })}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Link>
      </div>

      {/* Auth Container */}
      <div className="w-full max-w-md space-y-10">
        {/* Logo */}
        <div className="flex flex-col items-center space-y-3">
          <Link href="/" className="flex items-center space-x-2">
            <Image src={"/logo.svg"} alt="logo" width={32} height={32} />
            <span className="font-bold text-xl text-foreground">Learnova</span>
          </Link>
        </div>

        {/* Page Content */}
        {children}

        {/* Terms */}
        <p className="text-center text-sm leading-relaxed text-muted-foreground px-6">
          By clicking continue, you agree to our{" "}
          <Link href="#" className="underline hover:text-primary">
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link href="#" className="underline hover:text-primary">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </div>
  );
};

export default AuthLayout;
