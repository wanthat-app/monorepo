import type { Meta, StoryObj } from "@storybook/react";
import { BackButton } from "../components";

const meta: Meta<typeof BackButton> = { title: "Shared/BackButton", component: BackButton };
export default meta;
type Story = StoryObj<typeof BackButton>;

export const Default: Story = { args: { onClick: () => {}, label: "Back" } };

export const InHeader: Story = {
  render: () => (
    <div className="flex w-[340px] items-center gap-3">
      <BackButton onClick={() => {}} label="Back" />
      <h2 className="text-lg font-bold">Enter your code</h2>
    </div>
  ),
};

export const Rtl: Story = {
  render: () => (
    <div dir="rtl" className="flex w-[340px] items-center gap-3">
      <BackButton onClick={() => {}} label="חזרה" />
      <h2 className="text-lg font-bold">הזינו את הקוד</h2>
    </div>
  ),
};
