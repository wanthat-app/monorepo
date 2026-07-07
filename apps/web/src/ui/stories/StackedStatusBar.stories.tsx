import type { Meta, StoryObj } from "@storybook/react";
import { StackedStatusBar } from "../admin";

const meta: Meta<typeof StackedStatusBar> = {
  title: "Admin/StackedStatusBar",
  component: StackedStatusBar,
  decorators: [(S) => <div className="w-[340px]"><S /></div>],
};
export default meta;
type Story = StoryObj<typeof StackedStatusBar>;

export const CashbackStatus: Story = {
  args: {
    items: [
      { label: "Confirmed", pct: 72, detail: "1,884", tone: "confirmed" },
      { label: "Pending", pct: 21, detail: "549", tone: "awaiting" },
      { label: "Rejected", pct: 7, detail: "183", tone: "declined" },
    ],
  },
};
