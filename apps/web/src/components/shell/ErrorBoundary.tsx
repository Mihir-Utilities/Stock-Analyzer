"use client";

import { Component, type ReactNode } from "react";
import { ApiError } from "@/lib/api/client";

// Per-card error boundary primitive (docs/06 section 4.6): one failing card never blanks the page.
// Message + Retry + request id (docs/06 section 5, Error state).

interface Props {
  children: ReactNode;
  /** Short name of the card, used in the message and test id. */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  // No componentDidCatch on purpose: the error object is never logged, because messages can
  // carry request data. Only an ApiError message (already user-safe) is shown.

  private retry = () => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const requestId = error instanceof ApiError ? error.requestId : null;
    const label = this.props.label ?? "This section";
    return (
      <ErrorPanel
        title={`${label} could not be shown.`}
        message={
          error instanceof ApiError
            ? error.message
            : "Something went wrong while drawing this section."
        }
        requestId={requestId}
        onRetry={this.retry}
      />
    );
  }
}

export function ErrorPanel(props: {
  title: string;
  message: string;
  requestId?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid="error-panel"
      className="rounded-card border border-border bg-surface-1 p-4 text-body text-text-1"
    >
      <p className="font-medium">{props.title}</p>
      <p className="mt-1 text-text-2">{props.message}</p>
      {props.requestId ? (
        <p className="mt-1 text-caption text-text-3">
          Request id: <span data-testid="error-request-id">{props.requestId}</span>
        </p>
      ) : null}
      {props.onRetry ? (
        <button
          type="button"
          onClick={props.onRetry}
          data-testid="error-retry"
          className="touch-target mt-3 inline-flex h-11 items-center rounded-control border border-border bg-surface-2 px-4 text-body-sm font-medium text-text-1 hover:bg-surface-3"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
