import { LoginForm } from "@/components/login/LoginForm";
import { Footer } from "@/components/shell/Footer";
import { WakingBanner } from "@/components/shell/WakingBanner";

// docs/06 section 6.1: password only, no registration, no forgot-password (CLI reset in RUNBOOK).
export default function LoginPage() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* /login is outside AppShell, so the cold-start banner (UI-01) is mounted here too. */}
      <WakingBanner />
      <main id="main" className="mx-auto w-full max-w-sm flex-1 px-4 py-16">
        <h1 data-testid="login-title" className="text-page font-semibold text-text-1">
          Sign in
        </h1>
        <LoginForm />
      </main>
      <Footer pathname="/login" />
    </div>
  );
}
