import { Inbox, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Icon, one-sentence explanation, optional primary action. */
export function EmptyState({
  message,
  icon: Icon = Inbox,
  action,
}: {
  message: string;
  icon?: LucideIcon;
  action?: ReactNode;
}) {
  return (
    <div
      data-testid="empty-state"
      className="flex flex-col items-center gap-3 px-4 py-8 text-center text-text-2"
    >
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
      <p className="max-w-sm text-body-sm">{message}</p>
      {action}
    </div>
  );
}
