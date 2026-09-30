import { adminGetCourse } from "@/app/data/admin/admin-get-course";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import React from "react";
import EditCourseForm from "./_components/EditCourseForm";
import { CourseStructure } from "./_components/CourseStructure";

type Params = Promise<{ courseId: string }>;

const EditPage = async ({ params }: { params: Params }) => {
  const { courseId } = await params;
  const data = await adminGetCourse(courseId);

  return (
    <div className="w-full px-10 py-12 space-y-12">
      {/* Page header */}
      <div className="space-y-2 border-b border-muted/30 pb-6">
        <h1 className="text-4xl font-bold tracking-tight">Edit Course</h1>
        <p className="text-lg text-muted-foreground">
          Update details for <span className="font-semibold text-foreground">{data.title}</span>
        </p>
      </div>

      {/* Tabs Section */}
      <Tabs defaultValue="basic-info" className="w-full">
        {/* Sticky tab bar */}
        <div className="sticky top-0 z-10 border-b border-muted/30 bg-background">
          <TabsList className="grid grid-cols-2 gap-4 w-full max-w-3xl mx-auto p-0 bg-transparent">
            <TabsTrigger
              value="basic-info"
              className="w-full py-4 text-lg font-medium rounded-none bg-transparent 
        data-[state=active]:text-primary data-[state=active]:border-b-2 data-[state=active]:border-primary 
        data-[state=inactive]:text-muted-foreground data-[state=inactive]:border-b-2 data-[state=inactive]:border-transparent
        transition-colors"
            >
              Basic Info
            </TabsTrigger>
            <TabsTrigger
              value="course-info"
              className="w-full py-4 text-lg font-medium rounded-none bg-transparent 
        data-[state=active]:text-primary data-[state=active]:border-b-2 data-[state=active]:border-primary 
        data-[state=inactive]:text-muted-foreground data-[state=inactive]:border-b-2 data-[state=inactive]:border-transparent
        transition-colors"
            >
              Course Info
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Basic Info Tab */}
        <TabsContent value="basic-info" className="mt-8">
          <section className="space-y-6">
            <header>
              <h2 className="text-2xl font-semibold">Edit Basic Info</h2>
              <p className="text-muted-foreground mt-1">
                Update your course’s title, description, duration, level, price, and thumbnail.
              </p>
            </header>
            <Card className="bg-background border border-dashed border-muted/40 shadow-none">
              <CardContent className="p-8">
                <div className="max-w-5xl">
                  <EditCourseForm data={data} />
                </div>
              </CardContent>
            </Card>
          </section>
        </TabsContent>

        {/* Course Info Tab */}
        <TabsContent value="course-info" className="mt-8">
          <section className="space-y-6">
            <header>
              <h2 className="text-2xl font-semibold">Course Details</h2>
              <p className="text-muted-foreground mt-1">
                Manage lessons, modules, and additional course details here.
              </p>
            </header>
            <Card className="bg-background border border-dashed border-muted/40 shadow-none">
              <CardContent className="p-8">
                <div className="max-w-5xl">
                  <CourseStructure data={data} />
                </div>
              </CardContent>
            </Card>
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default EditPage;
