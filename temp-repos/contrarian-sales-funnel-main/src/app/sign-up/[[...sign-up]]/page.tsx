import { SignUp } from '@clerk/nextjs';

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string }>;
}) {
  const params = await searchParams;
  const redirectUrl = params.redirect_url || '/dashboard';
  
  return (
    <div className="flex min-h-screen items-center justify-center bg-linear-to-br from-gray-50 to-gray-100">
      <SignUp
        appearance={{
          elements: {
            formButtonPrimary: 
              'bg-blue-600 hover:bg-blue-700 text-sm normal-case',
            card: 'shadow-xl',
          },
        }}
        signInUrl="/sign-in"
        afterSignUpUrl={redirectUrl}
        redirectUrl={redirectUrl}
      />
    </div>
  );
}

