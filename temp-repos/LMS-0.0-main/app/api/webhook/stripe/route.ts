import { env } from "@/lib/env"
import { prisma } from "@/lib/prisma"
import { stripe } from "@/lib/stripe"
import { headers } from "next/headers"
import type { NextRequest } from "next/server"
import type Stripe from "stripe"

export const runtime = "nodejs"

export async function POST(req: NextRequest) {
  console.log("[v0] Stripe webhook received")

  const body = await req.text()
  const headersList = await headers()
  const signature = headersList.get("Stripe-Signature")

  console.log("[v0] Webhook details:", {
    hasBody: !!body,
    bodyLength: body.length,
    hasSignature: !!signature,
    webhookSecretConfigured: !!env.STRIPE_WEBHOOK_SECRET,
  })

  if (!signature) {
    console.error("[v0] Missing Stripe signature header")
    return new Response(JSON.stringify({ error: "Missing Stripe signature" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }

  let event: Stripe.Event

  try {
    console.log("[v0] Verifying webhook signature...")
    event = stripe.webhooks.constructEvent(body, signature, env.STRIPE_WEBHOOK_SECRET)
    console.log("[v0] Webhook signature verified successfully")
  } catch (error) {
    console.error("[v0] Webhook signature verification failed:", error)
    console.error("[v0] Error details:", {
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    return new Response(
      JSON.stringify({
        error: "Webhook signature verification failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }

  const session = event.data.object as Stripe.Checkout.Session

  console.log("[v0] Processing event type:", event.type)

  if (event.type === "checkout.session.completed") {
    const courseId = session.metadata?.courseId as string
    const enrollementId = session.metadata?.enrollementId as string
    const customerId = session.customer as string

    console.log("[v0] Session metadata:", { courseId, enrollementId, customerId })

    if (!courseId || !customerId || !enrollementId) {
      console.error("[v0] Missing required metadata:", { courseId, enrollementId, customerId })
      return new Response(JSON.stringify({ error: "Invalid session data - missing metadata" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    try {
      const user = await prisma.user.findUnique({
        where: {
          stripeCustomerId: customerId,
        },
      })

      if (!user) {
        console.error("[v0] User not found for customer:", customerId)
        return new Response(JSON.stringify({ error: "User not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })
      }

      const amount = Math.round((session.amount_total || 0) / 100)

      console.log("[v0] Updating enrollment:", {
        enrollementId,
        userId: user.id,
        courseId,
        amount,
        currency: session.currency,
      })

      await prisma.enrollement.update({
        where: {
          id: enrollementId,
        },
        data: {
          userId: user.id,
          courseId: courseId,
          amount: amount,
          status: "ACTIVE",
        },
      })

      console.log("[v0] Enrollment updated successfully")
    } catch (error) {
      console.error("[v0] Database error:", error)
      return new Response(
        JSON.stringify({
          error: "Database error",
          message: error instanceof Error ? error.message : "Unknown error",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      )
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}
