import type { Meta, StoryObj } from "@storybook/react";
import { TextField } from "../components";

const meta: Meta<typeof TextField> = {
  title: "Shared/TextField",
  component: TextField,
  decorators: [(S) => <div className="w-[360px]"><S /></div>],
};
export default meta;
type Story = StoryObj<typeof TextField>;

export const Default: Story = { args: { label: "First name", name: "firstName", defaultValue: "Maya" } };

export const Placeholder: Story = {
  args: { label: "Email", name: "email", type: "email", placeholder: "maya@email.com" },
};

export const WithError: Story = {
  args: {
    label: "Email",
    name: "email2",
    type: "email",
    defaultValue: "maya@invalid",
    error: "Enter a valid email address",
  },
};
