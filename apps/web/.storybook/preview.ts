import type { Preview } from "@storybook/react";
import "../src/index.css";

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    backgrounds: {
      default: "page",
      values: [
        { name: "page", value: "#e9edeb" },
        { name: "surface", value: "#ffffff" },
        { name: "ink", value: "#15201c" },
      ],
    },
  },
};

export default preview;
