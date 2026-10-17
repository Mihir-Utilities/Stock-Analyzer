// Footer disclaimer on every page (SAF-03). Strings are exact (docs/06-frontend-spec.md section 9).
export const DISCLAIMER =
  "Personal research tool. Data may be delayed, incomplete or wrong. Not investment advice.";
export const MF_ATTRIBUTION = "NAV data: AMFI via mfapi.in.";

export function isMutualFundPath(pathname: string): boolean {
  return pathname === "/mf" || pathname.startsWith("/mf/");
}

export function Footer({ pathname }: { pathname: string }) {
  return (
    <footer
      data-testid="app-footer"
      className="border-t border-border px-4 py-4 text-caption text-text-2 desktop:px-6"
    >
      <p data-testid="app-disclaimer">{DISCLAIMER}</p>
      {isMutualFundPath(pathname) ? (
        <p data-testid="mf-attribution" className="mt-1">
          {MF_ATTRIBUTION}
        </p>
      ) : null}
    </footer>
  );
}
