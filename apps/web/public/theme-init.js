// Applies the saved or system theme before first paint. Served as a same-origin file because the
// CSP forbids inline scripts without a nonce. Keep the storage key in sync with use-theme.ts.
(function () {
  var theme = "dark";
  try {
    var stored = localStorage.getItem("analyzer-theme");
    if (stored === "dark" || stored === "light") {
      theme = stored;
    } else if (window.matchMedia && !window.matchMedia("(prefers-color-scheme: dark)").matches) {
      theme = "light";
    }
  } catch {
    /* storage blocked: fall back to dark */
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
