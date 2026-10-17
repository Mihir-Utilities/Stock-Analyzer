import type { Decorator, Preview } from "@storybook/nextjs-vite";
import "../src/app/globals.css";
import { themeStylesheet } from "../src/lib/theme/theme-css";

// Every story renders in the real token CSS, in dark or light (toolbar switch; docs/06a section 9).
const withTheme: Decorator = (Story, context) => {
  const theme = context.globals["theme"] === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);
  return (
    <>
      <style>{themeStylesheet()}</style>
      <Story />
    </>
  );
};

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: "Theme",
      toolbar: {
        title: "Theme",
        items: [
          { value: "dark", title: "Dark" },
          { value: "light", title: "Light" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "dark" },
  parameters: { layout: "fullscreen", backgrounds: { disable: true } },
};

export default preview;
