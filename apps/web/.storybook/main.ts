import type { StorybookConfig } from "@storybook/nextjs-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  framework: "@storybook/nextjs-vite",
  staticDirs: ["../public"],
  core: { disableTelemetry: true },
};

export default config;
