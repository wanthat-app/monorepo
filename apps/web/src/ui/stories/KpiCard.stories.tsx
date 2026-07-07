import type { Meta, StoryObj } from "@storybook/react";
import { KpiCard } from "../admin";

const SHEKEL = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
  </svg>
);
const CLOCK = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
const USERS = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
  </svg>
);

const meta: Meta<typeof KpiCard> = {
  title: "Admin/KpiCard",
  component: KpiCard,
  decorators: [(S) => <div className="w-[260px]"><S /></div>],
};
export default meta;
type Story = StoryObj<typeof KpiCard>;

export const CashbackPaid: Story = {
  args: { label: "Cashback paid", icon: SHEKEL, value: "₪48,220", delta: "▲ 12%", deltaNote: "vs last 30d" },
};

export const PendingPayouts: Story = {
  args: { label: "Pending payouts", icon: CLOCK, tone: "pending", value: "₪6,180", delta: "23", deltaNote: "awaiting review" },
};

export const ActiveUsers: Story = {
  args: { label: "Active users", icon: USERS, value: "3,412", delta: "+118", deltaNote: "new this week" },
};
