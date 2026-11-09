"use client";

import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useCreateLinkCode, useMe, useTelegramTest, useUnlinkTelegram } from "@/lib/alerts/api";
import type { LinkCode } from "@/lib/alerts/schemas";
import {
  countdownText,
  remainingSeconds,
  safeDeepLink,
  telegramErrorText,
} from "@/lib/alerts/text";
import { useSingleFlight } from "@/lib/imports/single-flight";

/** The app asks `/auth/me` every 3 s for up to 2 minutes after a code is made (docs/06 6.8). */
export const POLL_INTERVAL_MS = 3000;
export const POLL_WINDOW_MS = 120_000;

const BTN =
  "touch-target h-9 rounded-control border border-border px-3 text-body-sm text-text-1 hover:bg-surface-3 disabled:opacity-50";

/**
 * Telegram link card: bot not configured / not linked / linked (D-9: the bot may not exist yet, so
 * every state says plainly what is missing). The link code lives in component state only: it is
 * never stored, logged or put in a URL, and it is dropped when it expires or the chat links.
 */
export function TelegramCard() {
  const [code, setCode] = useState<LinkCode | null>(null);
  const [polling, setPolling] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const me = useMe({ pollMs: polling ? POLL_INTERVAL_MS : false });
  const link = useCreateLinkCode();
  const test = useTelegramTest();
  const unlink = useUnlinkTelegram();
  const once = useSingleFlight();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);

  const linked = me.data?.data.telegram_linked === true;
  const left = code ? remainingSeconds(code.expires_at, now) : 0;
  const codeLive = code !== null && left > 0 && !linked;

  // Countdown: one local timer, no requests.
  useEffect(() => {
    if (!codeLive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [codeLive]);

  // Stop polling two minutes after the latest code was made (a new code restarts the window,
  // F12R-3), or once linked. The cleanup also stops it on unmount.
  useEffect(() => {
    if (!polling) return;
    const id = setTimeout(() => setPolling(false), POLL_WINDOW_MS);
    return () => clearTimeout(id);
  }, [polling, code]);
  const hadCode = useRef(false);
  useEffect(() => {
    hadCode.current = code !== null;
  }, [code]);
  useEffect(() => {
    if (!linked) return;
    // Linked: the one-time code is no longer needed; drop it and stop asking.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCode(null);
    setPolling(false);
    if (hadCode.current) setNote("Telegram is now linked.");
  }, [linked]);

  useEffect(() => {
    if (codeLive) headingRef.current?.focus();
  }, [code, codeLive]);
  useEffect(() => {
    if (note) noteRef.current?.focus();
  }, [note]);

  const makeCode = () =>
    once(async () => {
      setNote(null);
      const r = await link.mutateAsync();
      setCode(r.data);
      setNow(Date.now());
      setPolling(true);
    });

  const botMissing = code !== null && (code.bot_username === null || code.deep_link === null);
  const deep = code ? safeDeepLink(code.deep_link) : null;
  const waitedOut = code !== null && !polling && !linked && left > 0;

  let body: React.ReactNode;
  if (me.isPending) {
    body = <p className="text-body-sm text-text-2">Checking Telegram status.</p>;
  } else if (me.isError && !code) {
    body = (
      <div className="flex flex-col items-start gap-2">
        <Banner tone="error" testId="telegram-me-error">
          Could not check whether Telegram is linked.
        </Banner>
        <button
          type="button"
          data-testid="telegram-retry"
          onClick={() => void me.refetch()}
          className={BTN}
        >
          Retry
        </button>
      </div>
    );
  } else if (linked) {
    body = (
      <div className="flex flex-col items-start gap-3">
        <p data-testid="telegram-linked" className="text-body-sm text-text-1">
          Telegram is linked. Alerts are sent to your linked chat.
        </p>
        <p data-testid="telegram-one-chat" className="text-body-sm text-text-2">
          Only one chat can be linked. To use a different chat, unlink this one first; a code used
          from a second chat is refused while one is linked.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="telegram-test"
            disabled={test.isPending}
            onClick={() =>
              once(async () => {
                setNote(null);
                await test.mutateAsync();
                setNote("Test message sent. Check your Telegram chat.");
              })
            }
            className={BTN}
          >
            {test.isPending ? "Sending" : "Send test message"}
          </button>
          <button
            type="button"
            data-testid="telegram-unlink"
            onClick={() => setConfirmUnlink(true)}
            className={BTN}
          >
            Unlink Telegram
          </button>
        </div>
        {test.isError ? (
          <Banner tone="error" testId="telegram-test-error">
            {telegramErrorText(test.error)}
          </Banner>
        ) : null}
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col items-start gap-3">
        {!codeLive ? (
          <p data-testid="telegram-not-linked" className="text-body-sm text-text-1">
            {code ? "The code expired. Make a new one." : "Telegram is not linked yet."} Alerts are
            kept as pending and sent once you link (alerts younger than 24 hours).
          </p>
        ) : null}
        {codeLive && code ? (
          <div
            data-testid="telegram-code-panel"
            className="flex flex-col gap-2 rounded-card border border-border bg-surface-2 p-3"
          >
            <h4
              ref={headingRef}
              tabIndex={-1}
              data-testid="telegram-code-heading"
              className="text-body font-semibold text-text-1 outline-none focus-visible:outline-2 focus-visible:outline-accent"
            >
              Your link code
            </h4>
            <p
              data-testid="telegram-code"
              className="font-mono text-lead tracking-widest text-text-1"
            >
              {code.code}
            </p>
            <p data-testid="telegram-countdown" className="text-body-sm text-text-2">
              Expires in {countdownText(left)}. It works once and is shown only on this screen.
            </p>
            {botMissing ? (
              <Banner tone="warn" testId="telegram-bot-missing">
                The Telegram bot is not set up on the server yet, so this code cannot be used for
                now. Alerts stay pending until the bot exists and a chat is linked.
              </Banner>
            ) : (
              <p className="text-body-sm text-text-1">
                Open the bot and send <span className="font-mono">/start {code.code}</span>
                {deep ? (
                  <>
                    {" "}
                    or{" "}
                    <ExternalLink
                      href={deep}
                      data-testid="telegram-deep-link"
                      className="underline"
                    >
                      open the bot in Telegram
                    </ExternalLink>
                  </>
                ) : null}
                .
              </p>
            )}
            {polling ? (
              <p data-testid="telegram-waiting" className="text-body-sm text-text-2">
                Waiting for the link. The server can take up to a minute to answer after an idle
                period.
              </p>
            ) : null}
          </div>
        ) : null}
        {waitedOut ? (
          <button
            type="button"
            data-testid="telegram-check-again"
            onClick={() => {
              void me.refetch();
              setPolling(true);
            }}
            className={BTN}
          >
            Check again
          </button>
        ) : null}
        <button
          type="button"
          data-testid="telegram-make-code"
          disabled={link.isPending}
          onClick={makeCode}
          className={BTN}
        >
          {link.isPending ? "Making code" : codeLive ? "Make a new code" : "Link Telegram"}
        </button>
        {link.isError ? (
          <Banner tone="error" testId="telegram-code-error">
            {telegramErrorText(link.error)}
          </Banner>
        ) : null}
      </div>
    );
  }

  return (
    <Card title="Telegram" testId="telegram-card">
      {body}
      <p
        ref={noteRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        data-testid="telegram-note"
        className="mt-2 text-body-sm text-text-1 outline-none"
      >
        {note ?? ""}
      </p>
      {linked ? (
        <ConfirmDialog
          open={confirmUnlink}
          title="Unlink Telegram?"
          message="Alerts will stay pending until you link a chat again."
          confirmLabel="Unlink"
          danger
          busy={unlink.isPending}
          onConfirm={() =>
            once(async () => {
              await unlink.mutateAsync();
              setConfirmUnlink(false);
              setNote("Telegram unlinked.");
            })
          }
          onCancel={() => setConfirmUnlink(false)}
        />
      ) : null}
      {unlink.isError ? (
        <Banner tone="error" testId="telegram-unlink-error">
          {telegramErrorText(unlink.error)}
        </Banner>
      ) : null}
    </Card>
  );
}
