import type { AnchorHTMLAttributes } from "react";

/**
 * Link to another site (docs, sources). Always opens in a new tab with rel="noopener noreferrer"
 * (CLAUDE.md security checklist); use this instead of a bare `target="_blank"`.
 */
export function ExternalLink({
  href,
  children,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "target" | "rel"> & { href: string }) {
  return (
    <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
