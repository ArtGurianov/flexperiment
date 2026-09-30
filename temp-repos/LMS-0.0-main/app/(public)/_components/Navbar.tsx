"use client";
import { Button } from "@/components/ui/button";
import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ModeToggle } from "@/components/ui/ModeToggle";
import UserDropdown from "./UserDropdown";
import { authClient } from "@/lib/auth-client";
import { usePathname } from "next/navigation";
import Image from "next/image";

const Navbar = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const pathname = usePathname();
  const { data: session } = authClient.useSession();

  const dashboardHref = session?.user?.role === 'admin' ? '/admin' : '/dashboard'
  const navigationLinks = [
    { name: "Home", href: "/" },
    { name: "Courses", href: "/courses" },
    { name: "Dashboard", href: dashboardHref },
  ];

  const isActiveLink = (href: string) => pathname === href;

  return (
    <nav className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto w-full px-4 sm:px-6 lg:px-8 flex h-16 items-center justify-between">
        {/* Logo */}
        <Link href="/" className="flex items-center space-x-2">
          <Image src={"/logo.svg"} alt="logo" width={32} height={32} />
          <span className="font-bold text-xl text-foreground">Learnova</span>
        </Link>

        {/* Desktop Nav Links */}
        <div className="hidden md:flex items-center space-x-6">
          {navigationLinks.map((link) => (
            <Link
              key={link.name}
              href={link.href}
              className={`text-sm font-medium transition-colors hover:text-primary ${isActiveLink(link.href) ? "text-primary" : "text-muted-foreground"
                }`}
            >
              {link.name}
            </Link>
          ))}
        </div>

        {/* Right Actions */}
        <div className="flex items-center space-x-4">
          <ModeToggle />

          {!session ? (
            <div className="hidden md:flex items-center space-x-2">
              <Button variant="ghost" size="sm" asChild className="rounded-lg">
                <Link href="/login">Login</Link>
              </Button>
              <Button size="sm" asChild className="rounded-lg">
                <Link href="/admin/courses">Get Started</Link>
              </Button>
            </div>
          ) : (
            <div className="hidden md:flex items-center">
              <UserDropdown
                name={session.user.name ?? ""}
                email={session.user.email ?? ""}
                image={session.user.image ?? ""}
              />
            </div>
          )}

          {/* Mobile Menu Toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
          >
            {isMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
        </div>
      </div>

      {/* Mobile Menu */}
      {isMenuOpen && (
        <div className="md:hidden border-t border-border">
          <div className="px-4 py-4 space-y-4">
            {navigationLinks.map((link) => (
              <Link
                key={link.name}
                href={link.href}
                className={`block text-sm font-medium transition-colors hover:text-primary ${isActiveLink(link.href) ? "text-primary" : "text-muted-foreground"
                  }`}
                onClick={() => setIsMenuOpen(false)}
              >
                {link.name}
              </Link>
            ))}

            {!session ? (
              <div className="flex flex-col space-y-2 pt-4 border-t border-border">
                <Button variant="ghost" size="sm" asChild className="rounded-lg">
                  <Link href="/login" onClick={() => setIsMenuOpen(false)}>
                    Login
                  </Link>
                </Button>
                <Button size="sm" asChild className="rounded-lg">
                  <Link href="/admin/courses" onClick={() => setIsMenuOpen(false)}>
                    Get Started
                  </Link>
                </Button>
              </div>
            ) : (
              <div className="pt-4 border-t border-border">
                <UserDropdown
                  name={session.user.name ?? ""}
                  email={session.user.email ?? ""}
                  image={session.user.image ?? ""}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </nav>
  );
};

export default Navbar;
