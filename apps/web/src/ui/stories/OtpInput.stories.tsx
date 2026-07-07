import type { Meta, StoryObj } from "@storybook/react";
import { OtpInput } from "../components";

const meta: Meta<typeof OtpInput> = {
  title: "Shared/OtpInput",
  component: OtpInput,
  decorators: [(S) => <div className="w-[360px]"><S /></div>],
};
export default meta;
type Story = StoryObj<typeof OtpInput>;

export const Empty: Story = {
  args: { name: "otp-empty", label: "Enter the code we sent", value: "", onChange: () => {} },
};

export const Filled: Story = {
  args: { name: "otp-filled", label: "Enter the code we sent", value: "482913", onChange: () => {} },
};

export const WithError: Story = {
  args: {
    name: "otp-error",
    label: "Enter the code we sent",
    value: "111111",
    error: "That code didn't match — try again",
    onChange: () => {},
  },
};
