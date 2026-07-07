import type { Meta, StoryObj } from "@storybook/react";
import { Spinner } from "../components";

const meta: Meta<typeof Spinner> = { title: "Shared/Spinner", component: Spinner };
export default meta;
type Story = StoryObj<typeof Spinner>;

export const OnAccent: Story = {
  render: () => (
    <div className="inline-flex items-center gap-2 rounded-button bg-accent px-5 py-4 text-white">
      <Spinner />
      <span className="font-display font-semibold">Pulling product details…</span>
    </div>
  ),
};

export const OnLight: Story = {
  render: () => (
    <div className="inline-flex items-center gap-2 text-accent">
      <Spinner />
      <span className="text-sm font-medium">Loading your wallet…</span>
    </div>
  ),
};
