import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { WakingTracker } from "@/lib/api/waking";
import { AppShell } from "./AppShell";
import { ErrorPanel } from "./ErrorBoundary";
import { Footer } from "./Footer";
import { ThemeToggle } from "./ThemeToggle";
import { WakingBanner } from "./WakingBanner";

const meta: Meta = { title: "Shell" };
export default meta;
type Story = StoryObj;

export const Shell: Story = {
  render: () => (
    <AppShell>
      <h1 className="text-page font-semibold">Page content</h1>
      <p className="mt-2 text-text-2">
        Resize to 320, 375, 768, 1024 or 1440 px to see both shells.
      </p>
    </AppShell>
  ),
  parameters: { nextjs: { navigation: { pathname: "/stocks" } } },
};

export const ShellOnFundsPage: Story = {
  render: () => <AppShell>Funds page: shows the AMFI/mfapi attribution.</AppShell>,
  parameters: { nextjs: { navigation: { pathname: "/mf" } } },
};

export const ThemeToggleButton: Story = { render: () => <ThemeToggle /> };

export const FooterDisclaimer: Story = { render: () => <Footer pathname="/" /> };

function wakingTracker(): WakingTracker {
  // A clock that is already 12 s in, so the banner is visible without waiting.
  let t = 0;
  const tracker = new WakingTracker(() => t);
  tracker.begin();
  t = 12_000;
  tracker.refresh();
  return tracker;
}

export const WakingServer: Story = { render: () => <WakingBanner tracker={wakingTracker()} /> };

export const ErrorState: Story = {
  render: () => (
    <div className="p-4">
      <ErrorPanel
        title="Price card could not be shown."
        message="The server did not answer within 70 seconds."
        requestId="req-12345678"
        onRetry={() => undefined}
      />
    </div>
  ),
};
