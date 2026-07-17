import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "../components";

const meta: Meta<typeof Button> = {
  title: "Shared/Button",
  component: Button,
  argTypes: {
    variant: { control: "select", options: ["primary", "ink", "ghost", "mint", "outline"] },
  },
  args: { variant: "primary", loading: false, disabled: false, children: "Sign up to earn" },
};
export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = {};

export const Ink: Story = { args: { variant: "ink", children: "Back to home" } };

export const Outline: Story = { args: { variant: "outline", children: "Log in" } };

export const Ghost: Story = { args: { variant: "ghost", children: "Skip for now" } };

export const MintOnInk: Story = {
  args: { variant: "mint", children: "Withdraw cash" },
  render: (args) => (
    <div className="rounded-feature bg-ink p-6">
      <Button {...args} />
    </div>
  ),
};

export const Loading: Story = { args: { loading: true, children: "Pulling product details…" } };

export const Disabled: Story = { args: { disabled: true, children: "Continue" } };
