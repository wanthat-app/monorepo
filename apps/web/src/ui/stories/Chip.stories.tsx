import type { Meta, StoryObj } from "@storybook/react";
import { Chip } from "../components";

const meta: Meta<typeof Chip> = {
  title: "Shared/Chip",
  component: Chip,
  argTypes: { tone: { control: "select", options: ["accent", "mint", "onink", "neutral", "base"] } },
};
export default meta;
type Story = StoryObj<typeof Chip>;

export const Accent: Story = { args: { tone: "accent", children: "On" } };
export const Neutral: Story = { args: { tone: "neutral", children: "v1.0" } };
export const Base: Story = { args: { tone: "base", children: "preview" } };

export const MintOnInk: Story = {
  args: { tone: "mint", children: "Estimated" },
  render: (args) => (
    <div className="rounded-card bg-ink p-5">
      <Chip {...args} />
    </div>
  ),
};

export const SampleOnInk: Story = {
  args: { tone: "onink", children: "Sample" },
  render: (args) => (
    <div className="rounded-card bg-ink p-5">
      <Chip {...args} />
    </div>
  ),
};
