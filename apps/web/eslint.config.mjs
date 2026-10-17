import js from "@eslint/js";
import nextVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      "storybook-static/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  { files: ["**/*.{ts,tsx}"], extends: [...tseslint.configs.recommended] },
  ...nextVitals,
  {
    files: ["**/*.{ts,tsx}"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
);
