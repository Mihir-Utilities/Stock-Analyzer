import { Footer } from "@/components/shell/Footer";

// Placeholder so the auth gate has somewhere to redirect. The password form, show/hide and the
// error copy are built in F04 (docs/06 section 6.1); the validated `next` helper is lib/safe-next.
export default function LoginPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <main id="main" className="mx-auto w-full max-w-sm flex-1 px-4 py-16">
        <h1 data-testid="login-title" className="text-page font-semibold text-text-1">
          Sign in
        </h1>
        <p className="mt-2 text-body text-text-2">The sign-in form arrives in a later task.</p>
      </main>
      <Footer pathname="/login" />
    </div>
  );
}
