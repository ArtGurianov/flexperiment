"use client";

import {
  IconCreditCard,
  IconDotsVertical,
  IconLogout,
  IconNotification,
  IconUserCircle,
} from "@tabler/icons-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";
import Link from "next/link";
import { BookOpenIcon, Home, LayoutDashboard, LogOutIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export function NavUser() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const { isMobile } = useSidebar();

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

  if (isPending) {
    return null;
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
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
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">
                  {session?.user.name && session?.user.name.length > 0
                    ? session?.user.name.charAt(0).toUpperCase()
                    : session?.user.email.split("@")[0]}
                </span>
                <span className="text-muted-foreground truncate text-xs">
                  {session?.user.email}
                </span>
              </div>
              <IconDotsVertical className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
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
                    {" "}
                    {session?.user.name && session?.user.name.length > 0
                      ? session?.user.name.charAt(0).toUpperCase()
                      : session?.user.email.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">
                    {" "}
                    {session?.user.name && session?.user.name.length > 0
                      ? session?.user.name.charAt(0).toUpperCase()
                      : session?.user.email.split("@")[0]}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">
                    {session?.user.email}
                  </span>
                </div>
              </div>
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
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
