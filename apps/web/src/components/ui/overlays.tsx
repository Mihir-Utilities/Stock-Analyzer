"use client";

import { CircleHelp, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cx } from "./cx";

// Overlay primitives built on native elements (<dialog>, aria attributes) instead of Radix, to
// keep the dependency list short; see OPEN_QUESTIONS F02-1.

/** Hover/focus tooltip for short text. The trigger must be focusable (a button or link). */
export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  const id = useId();
  return (
    <span className="group relative inline-flex" data-testid="tooltip-wrap">
      <span aria-describedby={id} className="inline-flex">
        {children}
      </span>
      <span
        id={id}
        role="tooltip"
        data-testid="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-30 mt-1 hidden w-max max-w-xs -translate-x-1/2 rounded-control border border-border bg-surface-2 px-2 py-1 text-caption text-text-1 group-focus-within:block group-hover:block"
      >
        {text}
      </span>
    </span>
  );
}

/** Info button that opens a small panel (definition, formula, source). Esc or outside click closes. */
export function InfoPopover({
  label,
  children,
  testId = "info-popover",
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <span
      ref={root}
      className="relative inline-flex"
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex size-6 items-center justify-center rounded-control text-text-2 hover:bg-surface-3"
      >
        <CircleHelp size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open ? (
        <div
          id={id}
          role="region"
          aria-label={label}
          data-testid={`${testId}-panel`}
          className="absolute left-0 top-full z-30 mt-1 w-64 rounded-control border border-border bg-surface-2 p-3 text-body-sm text-text-1"
        >
          {children}
        </div>
      ) : null}
    </span>
  );
}

function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    }
    if (!open && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  }, [open]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    d.addEventListener("cancel", onCancel);
    return () => d.removeEventListener("cancel", onCancel);
  }, [onClose]);
  return ref;
}

/** Modal confirmation. Destructive actions use the `danger` tone and the cancel button has focus. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useDialog(open, onCancel);
  const titleId = useId();
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-testid="confirm-dialog"
      className="m-auto w-full max-w-sm rounded-card border border-border bg-surface-1 p-4 text-text-1 backdrop:bg-black/50"
    >
      <h2 id={titleId} className="text-lead font-semibold">
        {title}
      </h2>
      <div className="mt-2 text-body-sm text-text-2">{message}</div>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          data-testid="confirm-cancel"
          autoFocus
          onClick={onCancel}
          className="h-9 rounded-control border border-border px-3 text-body-sm hover:bg-surface-3"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          data-testid="confirm-ok"
          onClick={onConfirm}
          className={cx(
            "h-9 rounded-control border px-3 text-body-sm font-medium hover:bg-surface-3",
            danger ? "border-down text-text-1" : "border-accent text-text-1",
          )}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

/** Side drawer (right on desktop, full width on mobile). */
export function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useDialog(open, onClose);
  const titleId = useId();
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-testid="drawer"
      className="m-0 ml-auto h-full max-h-none w-full max-w-md border-l border-border bg-surface-1 p-4 text-text-1 backdrop:bg-black/50"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={titleId} className="text-lead font-semibold">
          {title}
        </h2>
        <button
          type="button"
          data-testid="drawer-close"
          aria-label="Close"
          onClick={onClose}
          className="inline-flex size-9 items-center justify-center rounded-control hover:bg-surface-3"
        >
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <div className="mt-3">{children}</div>
    </dialog>
  );
}

export interface ToastItem {
  id: number;
  message: string;
  tone: "info" | "error";
}

const ToastContext = createContext<(message: string, tone?: ToastItem["tone"]) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

/** Toast region (polite live region). Toasts close themselves after `durationMs` or on click. */
export function ToastProvider({
  children,
  durationMs = 5000,
}: {
  children: ReactNode;
  durationMs?: number;
}) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (message: string, tone: ToastItem["tone"] = "info") => {
      const id = next.current++;
      setItems((l) => [...l, { id, message, tone }]);
      setTimeout(() => dismiss(id), durationMs);
    },
    [dismiss, durationMs],
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        role="status"
        aria-live="polite"
        data-testid="toast-region"
        className="fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {items.map((t) => (
          <div
            key={t.id}
            data-testid="toast"
            data-tone={t.tone}
            className={cx(
              "flex items-start justify-between gap-2 rounded-control border bg-surface-2 px-3 py-2 text-body-sm text-text-1",
              t.tone === "error" ? "border-down" : "border-border",
            )}
          >
            <span>{t.message}</span>
            <button
              type="button"
              data-testid="toast-close"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
              className="shrink-0 text-text-2"
            >
              <X size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export interface TabDef {
  id: string;
  label: string;
  content: ReactNode;
}

/** Accessible tabs: arrow keys move, Home/End jump; only the active panel is rendered. */
export function Tabs({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: TabDef[];
  value?: string;
  onChange?: (id: string) => void;
  label: string;
}) {
  const [inner, setInner] = useState(tabs[0]?.id ?? "");
  const active = value ?? inner;
  const base = useId();
  const select = (id: string) => {
    setInner(id);
    onChange?.(id);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === active);
    let n: number;
    if (e.key === "ArrowRight") n = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = tabs.length - 1;
    else return;
    e.preventDefault();
    const t = tabs[n];
    if (t) {
      select(t.id);
      document.getElementById(`${base}-tab-${t.id}`)?.focus();
    }
  };
  const current = useMemo(() => tabs.find((t) => t.id === active), [tabs, active]);
  return (
    <div>
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKey}
        className="flex gap-1 overflow-x-auto border-b border-border"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`${base}-tab-${t.id}`}
            type="button"
            role="tab"
            data-testid={`tab-${t.id}`}
            aria-selected={t.id === active}
            aria-controls={`${base}-panel`}
            tabIndex={t.id === active ? 0 : -1}
            onClick={() => select(t.id)}
            className={cx(
              "h-9 whitespace-nowrap border-b-2 px-3 text-body-sm",
              t.id === active
                ? "border-accent font-medium text-text-1"
                : "border-transparent text-text-2 hover:text-text-1",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        id={`${base}-panel`}
        role="tabpanel"
        aria-labelledby={`${base}-tab-${active}`}
        tabIndex={0}
        className="pt-3"
      >
        {current?.content}
      </div>
    </div>
  );
}
