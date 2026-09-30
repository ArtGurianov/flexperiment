"use client";

import { ShieldX, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { motion } from "framer-motion";

export default function NotAdminRoute() {
  return (
    <div className="flex h-screen items-center justify-center bg-gradient-to-br from-red-50 via-white to-red-100 dark:from-zinc-950 dark:via-zinc-900 dark:to-zinc-800 p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 30 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="w-full max-w-md rounded-2xl bg-white dark:bg-zinc-900 p-8 shadow-2xl border border-red-200 dark:border-red-800 text-center"
      >
        <div className="flex justify-center">
          <motion.div
            initial={{ rotate: -20, scale: 0.8 }}
            animate={{ rotate: 0, scale: 1 }}
            transition={{ type: "spring", stiffness: 200, damping: 12 }}
            className="rounded-full bg-red-100 dark:bg-red-900/40 p-4 shadow-inner"
          >
            <ShieldX className="h-16 w-16 text-red-600 dark:text-red-400" />
          </motion.div>
        </div>

        <h1 className="mt-6 text-2xl font-bold text-gray-800 dark:text-gray-100">
          Access Restricted
        </h1>
        <p className="mt-2 text-gray-600 dark:text-gray-400">
          You are <span className="font-semibold text-red-500 dark:text-red-400">not an admin</span>
          . This page is restricted.
        </p>

        <div className="mt-6 flex justify-center">
          <Link href="/">
            <Button
              variant="outline"
              className="flex items-center gap-2 rounded-full border-red-500 dark:border-red-600 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-700 dark:hover:text-red-300 transition-all"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Home
            </Button>
          </Link>
        </div>
      </motion.div>
    </div>
  );
}
