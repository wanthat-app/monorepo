import type { Meta, StoryObj } from "@storybook/react";
import { TopNav } from "../wallet";

const meta: Meta<typeof TopNav> = {
  title: "Wallet/TopNav",
  component: TopNav,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof TopNav>;

export const Default: Story = {
  args: {
    links: [
      { key: "home", label: "Home", active: true },
      { key: "activity", label: "Activity" },
    ],
    createLabel: "Create",
    profileInitial: "M",
  },
};
