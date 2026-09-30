import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  BookOpen,
  Users,
  Layers,
  BarChart3,
  LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { reequireUser } from "../data/user/require-user";

interface Feature {
  icon: LucideIcon;
  title: string;
  description: string;
  iconColor: "primary" | "accent";
}

const features: Feature[] = [
  {
    icon: BookOpen,
    title: "Interactive Courses",
    description:
      "Engage with multimedia content, quizzes, and hands-on activities designed to enhance your learning experience.",
    iconColor: "primary",
  },
  {
    icon: Users,
    title: "Collaborative Learning",
    description:
      "Connect with peers, join study groups, and participate in discussions to learn together and grow as a community.",
    iconColor: "accent",
  },
  {
    icon: Layers,
    title: "Comprehensive Curriculum",
    description:
      "Follow structured learning paths that cover everything from fundamentals to advanced topics, ensuring complete mastery.",
    iconColor: "primary",
  },
  {
    icon: BarChart3,
    title: "Progress Tracking",
    description:
      "Monitor your learning progress with detailed analytics and personalized insights to stay motivated.",
    iconColor: "accent",
  },
];

// Map iconColor to actual Tailwind classes
const colorClasses: Record<"primary" | "accent", string> = {
  primary: "bg-blue-100 text-blue-600",
  accent: "bg-purple-100 text-purple-600",
};

export default async function Home() {
  const user = await reequireUser();

  return (
    <div className="min-h-screen bg-background">
      {/* Header Section */}
      <header className="container mx-auto px-4 py-16 text-center">
        <h1 className="text-4xl md:text-6xl font-bold text-foreground mb-6">
          Transform Your Learning Journey
        </h1>
        <p className="text-lg md:text-xl text-muted-foreground mb-8 max-w-3xl mx-auto">
          Experience the future of education with our comprehensive learning
          management system. Engage, learn, and grow with interactive courses
          designed for modern learners.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link href="/courses">
            <Button size="lg" className="px-8 cursor-pointer">
              Explore Courses
            </Button>
          </Link>

          {user ? (
            <Link href="/dashboard">
              <Button
                variant="outline"
                size="lg"
                className="px-8 cursor-pointer"
              >
                Continue Learning
              </Button>
            </Link>
          ) : (
            <Link href="/login">
              <Button
                variant="outline"
                size="lg"
                className="px-8 cursor-pointer"
              >
                Sign In
              </Button>
            </Link>
          )}
        </div>
      </header>

      {/* Features Section */}
      <section className="container mx-auto px-4 py-16">
        <h2 className="text-3xl md:text-4xl font-bold text-center text-foreground mb-12">
          Core Features
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feature, index) => {
            const IconComponent = feature.icon;
            const colors = colorClasses[feature.iconColor];

            return (
              <Card
                key={index}
                className="text-center shadow-sm hover:shadow-md transition-all rounded-xl"
              >
                <CardHeader>
                  <div
                    className={`mx-auto mb-4 p-3 rounded-full w-fit ${colors.split(" ")[0]}`}
                  >
                    <IconComponent
                      className={`h-8 w-8 ${colors.split(" ")[1]}`}
                    />
                  </div>
                  <CardTitle className="text-xl">{feature.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <CardDescription className="text-base">
                    {feature.description}
                  </CardDescription>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>
    </div>
  );
}
