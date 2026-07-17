import type { Meta, StoryObj } from "@storybook/react";
import { StatusBadge } from "../components";

const meta: Meta<typeof StatusBadge> = {
  title: "Shared/StatusBadge",
  component: StatusBadge,
  argTypes: {
    status: { control: "select", options: ["confirmed", "pending", "rejected", "neutral"] },
  },
};
export default meta;
type Story = StoryObj<typeof StatusBadge>;

export const Confirmed: Story = { args: { status: "confirmed", children: "Confirmed" } };
export const Pending: Story = { args: { status: "pending", children: "Pending" } };
export const Rejected: Story = { args: { status: "rejected", children: "Rejected" } };
export const Neutral: Story = { args: { status: "neutral", children: "3 cashbacks" } };
