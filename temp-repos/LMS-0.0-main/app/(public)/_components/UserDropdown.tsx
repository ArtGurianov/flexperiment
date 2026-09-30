"use client";
import { BookOpenIcon, ChevronDownIcon, Home, LayoutDashboard, LogOutIcon } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";

interface iAppProps {
  name: string;
  email: string;
  image: string;
}

export default function UserDropdown({ name, email, image }: iAppProps) {
  const router = useRouter();
  const { data: session } = authClient.useSession();

  async function signOut() {
    try {
      await authClient.signOut({
        fetchOptions: {
          onSuccess: () => {
            router.push("/login");
            toast.success("SignOut Successfully");
          },
        },
      });
    } catch (error) {
      toast.error("Sign out failed. Please try again.");
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-auto p-0 hover:bg-transparent">
          <Avatar className="h-8 w-8 rounded-lg">
            <AvatarImage
              src={session?.user.image ?? `https://avatar.vercel.sh/${session?.user.email}`}
              alt={
                session?.user.name && session?.user.name
                  ? session?.user.name[0].toUpperCase()
                  : session?.user.email[0].toUpperCase()
              }
            />
            <AvatarFallback className="rounded-lg">
              {session?.user.name && session?.user.name.length > 0
                ? session?.user.name.charAt(0).toUpperCase()
                : session?.user.email.charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <ChevronDownIcon size={16} className="opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-64">
        <DropdownMenuLabel className="flex min-w-0 flex-col">
          <span className="text-foreground truncate text-sm font-medium">{name}</span>
          <span className="text-muted-foreground truncate text-xs font-normal">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link href={"/"}>
              <Home size={16} className="opacity-60" aria-hidden="true" />
              <span>Home</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={"/admin/courses"}>
              <BookOpenIcon size={16} className="opacity-60" aria-hidden="true" />
              <span>Courses</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={"/admin"}>
              <LayoutDashboard size={16} className="opacity-60" aria-hidden="true" />
              <span>Dashboard</span>
            </Link>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut} className="cursor-pointer">
          <LogOutIcon size={16} className="opacity-60" aria-hidden="true" />
          <span>Logout</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
