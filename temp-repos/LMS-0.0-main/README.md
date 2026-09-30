# 🎓 Next.js LMS Platform

A modern **Learning Management System (LMS)** built with **Next.js 14, TypeScript, Tailwind CSS, Prisma, and Stripe**, featuring both **Admin and User dashboards** for managing and purchasing online courses.

🚀 **Live Demo:** [https://lms-0-0.vercel.app](https://lms-0-0.vercel.app)

---

## 📘 Overview

This LMS platform allows instructors (admins) to create, manage, and sell online courses, while users can browse, enroll, and track their learning progress through a clean and responsive dashboard. Payments are securely handled via **Stripe Checkout**.

---

Application Preview

Home Page
<img width="1066" height="757" alt="Home page" src="https://github.com/user-attachments/assets/75463726-e589-4792-9dc1-570662f475aa" />

Email Verification
<img width="1081" height="641" alt="verify" src="https://github.com/user-attachments/assets/5802ed2a-ffd8-4cb9-990e-53a14864859f" />


 Courses
 <img width="1066" height="895" alt="Courses for user" src="https://github.com/user-attachments/assets/f432a0c7-a85e-4b6d-97f0-b67f9c664835" />

 Dashboard
 <img width="1066" height="1180" alt="Dashboard" src="https://github.com/user-attachments/assets/e3b7acf9-00c4-4781-b781-df39846d506e" />

View Course Detail and Enroll in that Course
<img width="1066" height="990" alt="course Detail" src="https://github.com/user-attachments/assets/d41a2c66-15e5-434f-9754-98f187799bc2" />

Track Your Learning
<img width="1066" height="738" alt="start learning" src="https://github.com/user-attachments/assets/7193d8c2-7ff4-4c37-9488-8c35d9c6c508" />

Mark Complete as you finish the lesson
<img width="1066" height="738" alt="learn complete" src="https://github.com/user-attachments/assets/4a4af78b-bbe4-4857-933e-dff56c684c79" />



Admin Panel Preview

Dashboard
<img width="1066" height="1141" alt="admin" src="https://github.com/user-attachments/assets/e16678c8-47be-43ad-b10d-2ada39b9230a" />

Create Your Course
<img width="848" height="1494" alt="course create" src="https://github.com/user-attachments/assets/884136ca-1e57-4618-93c9-f72edf42894b" />



View Your Course Info
<img width="1066" height="1439" alt="courses" src="https://github.com/user-attachments/assets/f4388c54-9aae-452b-a2a4-debe73d12068" />


Edit Courses and you can reorder the chapters as well as lessons
<img width="1066" height="665" alt="edit course" src="https://github.com/user-attachments/assets/a4e14f72-9a23-4cdc-8dab-c85e26429c2c" />



Configure Image and Video for each Lessons
<img width="1066" height="1435" alt="configure thumbnail image and video for course" src="https://github.com/user-attachments/assets/85828d2f-ed30-48c3-a4cb-c87dbe3c920f" />





 




## ✨ Features

### 👨‍💼 Admin Dashboard
- Create, edit, and delete courses.
- Upload course thumbnails, titles, and detailed descriptions.
- Set course prices and publish/unpublish courses.
- View enrolled students and payment status.
- Manage course content such as chapters and lessons.

### 🎓 User Dashboard
- Browse available courses.
- View course details before enrollment.
- Purchase courses via **Stripe** integration.
- Access enrolled courses and track progress.
- Beautiful success and cancel pages for payment flow.

### 💳 Stripe Payment Integration
- Secure checkout powered by **Stripe**.
- Metadata tracking for enrollment verification.
- Automatic enrollment activation after successful payment.

---

## 🛠️ Tech Stack

| Category | Technology |
|-----------|-------------|
| Frontend | Next.js 14 (App Router), TypeScript, Tailwind CSS, shadcn/ui |
| Backend | Next.js Server Actions, Prisma ORM |
| Database | PostgreSQL (via Neon) |
| Auth | Better Auth |
| Payment | Stripe |
| Deployment | Vercel |
| Security | Arcjet rate limiting |

---

## ⚙️ Environment Variables

| Variable | Description |
|-----------|-------------|
| `DATABASE_URL` | PostgreSQL database connection string |
| `STRIPE_SECRET_KEY` | Stripe secret key for API access |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Public Stripe key |
| `BETTER_AUTH_URL` | Base URL of your deployed app |
| `ARCJET_KEY` | Arcjet API key (for rate limiting) |

---

🧾 License

This project is licensed under the MIT License — feel free to use, modify, and build upon it.


💬 Author

Developed by Suraj Silwal
📧 For inquiries: [suraj.silwal.dev@gmail.com
]
🌐 Project: https://lms-0-0.vercel.app



## Acknowledgments

- **Jan Marshal** - Foundational tutorial and project structure
