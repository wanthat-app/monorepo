import type { Meta, StoryObj } from "@storybook/react";
import { Button, Card, StatusBadge } from "../components";

const meta: Meta<typeof Card> = { title: "Shared/Card", component: Card };
export default meta;
type Story = StoryObj<typeof Card>;

export const RecentActivity: Story = {
  render: () => (
    <Card className="flex w-[380px] flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Recent activity</h2>
        <a href="#all" className="text-sm font-semibold text-accent">
          See all
        </a>
      </div>
      {[
        {
          store: "AliExpress order",
          when: "2 days ago",
          ils: "≈₪12.40",
          real: "+$3.35",
          status: "confirmed" as const,
          label: "Confirmed",
        },
        {
          store: "AliExpress order",
          when: "5 days ago",
          ils: "≈₪7.90",
          real: "+$2.14",
          status: "pending" as const,
          label: "Pending",
        },
        {
          store: "Shein order",
          when: "1 week ago",
          ils: "≈₪4.10",
          real: "+€1.02",
          status: "rejected" as const,
          label: "Rejected",
        },
      ].map((row) => (
        <div
          key={row.when}
          className="flex items-center justify-between border-t border-hairrow pt-3"
        >
          <div className="flex flex-col gap-0.5">
            <span className="text-[15px] font-semibold text-ink">{row.store}</span>
            <span className="text-xs text-subtle">{row.when}</span>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge status={row.status}>{row.label}</StatusBadge>
            <div className="flex flex-col items-end">
              <span className="tabular font-display text-[15px] font-bold text-ink">{row.ils}</span>
              <span className="tabular text-xs text-muted">{row.real}</span>
            </div>
          </div>
        </div>
      ))}
    </Card>
  ),
};

export const SimpleContent: Story = {
  render: () => (
    <Card className="flex w-[340px] flex-col gap-4">
      <h1 className="text-2xl">Welcome back, Maya</h1>
      <p className="text-muted">
        Share a product link and earn cashback when friends buy through it.
      </p>
      <Button>Create link</Button>
    </Card>
  ),
};

export const Lifted: Story = {
  render: () => (
    <Card lifted className="w-[340px]">
      <p className="text-sm text-secondary">
        Lifted surface — the soft card shadow is reserved for modals and the device frame.
      </p>
    </Card>
  ),
};
