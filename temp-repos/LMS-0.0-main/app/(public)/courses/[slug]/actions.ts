"use server";

import { reequireUser } from "@/app/data/user/require-user";
import arcjet, { fixedWindow } from "@/lib/arcjet";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { ApiResponse } from "@/lib/types";
import { request } from "@arcjet/next";
import { redirect } from "next/navigation";
import Stripe from "stripe";

const aj = arcjet.withRule(
  fixedWindow({
    mode: "LIVE",
    window: "1m",
    max: 5,
  })
);

export async function enrollInCourseAction(courseId: string): Promise<ApiResponse | never> {
  //check if user is logged in
  const user = await reequireUser();

  let checkoutUrl;
  try {
    const req = await request();
    const decision = await aj.protect(req, {
      fingerprint: user.id,
    });
    if (decision.isDenied()) {
      return {
        status: "error",
        message: "Too many requests. Please try again later.",
      };
    }
    //we get individual course details
    const course = await prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        title: true,
        price: true,
        slug: true,
        stripePriceId: true
      },
    });
    if (!course) {
      return {
        status: "error",
        message: "Course not found.",
      };
    }

    let stripeCustomerId: string;
    //check if user already has a stripe customer id
    const userWithStripeCustomerId = await prisma.user.findUnique({
      where: { id: user.id },
      select: { stripeCustomerId: true },
    });

    if (userWithStripeCustomerId?.stripeCustomerId) {
      stripeCustomerId = userWithStripeCustomerId.stripeCustomerId;
    } else {
      const customer = await stripe.customers.create({
        email: user.email || undefined,
        name: user.name,
        metadata: {
          userId: user.id,
        },
      });

      stripeCustomerId = customer.id;
      //update user with stripe customer id
      await prisma.user.update({
        where: { id: user.id },
        data: {
          stripeCustomerId: stripeCustomerId,
        },
      });
    }

    //we check if user is already enrolled in the course
    const result = await prisma.$transaction(async (tx) => {
      const existingEnrollment = await tx.enrollement.findUnique({
        where: {
          userId_courseId: {
            userId: user.id,
            courseId: course.id,
          },
        },
        select: { status: true, id: true },
      });

      if (existingEnrollment?.status === "ACTIVE") {
        return {
          status: "success",
          message: "You are already enrolled in this course.",
        };
      }

      let enrollment;

      if (existingEnrollment) {
        enrollment = await tx.enrollement.update({
          where: { id: existingEnrollment.id },
          data: { status: "PENDING", amount: course.price, updatedAt: new Date() },
        });
      } else {
        enrollment = await tx.enrollement.create({
          data: {
            userId: user.id,
            courseId: course.id,
            amount: course.price,
            status: "PENDING",
          },
        });
      }

      const checkoutSession = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        line_items: [
          {
            price_data: {
              currency: "usd", // Set this to match your desired currency
              product_data: {
                name: course.title,
                description: `Enrollment for ${course.title}`,
              },
              unit_amount: course.price * 100 
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        success_url: `${env.BETTER_AUTH_URL}/payment/success?enrollmentId=${enrollment?.id}`,

        cancel_url: `${env.BETTER_AUTH_URL}/payment/cancel`,
        metadata: {
          userId: user.id,
          courseId: course.id,
          enrollementId: enrollment?.id,
        },
      });
      return {
        enrollment: enrollment,
        checkoutUrl: checkoutSession.url,
      };
    });

    checkoutUrl = result.checkoutUrl as string;
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError) {
      return {
        status: "error",
        message: `Error from Stripe: ${error.message}`,
      };
    }
    return {
      status: "error",
      message: "Failed to enroll in course. Please try again.",
    };
  }

  redirect(checkoutUrl);
}
