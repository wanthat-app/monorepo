import type { Meta, StoryObj } from "@storybook/react";
import feeder from "../assets/product-feeder.jpg";
import { ActivityRow, Avatar } from "../wallet";

const meta: Meta<typeof ActivityRow> = {
  title: "Wallet/ActivityRow",
  component: ActivityRow,
  decorators: [
    (S) => (
      <div className="w-[420px]">
        <S />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof ActivityRow>;

export const ConfirmedLink: Story = {
  args: {
    thumb: <Avatar kind="product" src={feeder} size={44} />,
    title: "Jebao Fish Feeder",
    status: "confirmed",
    statusLabel: "Confirmed",
    meta: "Your link · 3 purchases",
    amount: "+₪37.20",
    amountSub: "+$10.05",
    onClick: () => {},
  },
};

export const PendingOrder: Story = {
  args: {
    thumb: <Avatar kind="placeholder" size={44} />,
    title: "USB-C 7-in-1 Hub",
    status: "pending",
    statusLabel: "Pending",
    meta: "Your order · 2 days ago",
    amount: "+₪3.10",
    amountSub: "+$0.84",
  },
};

export const RejectedOrder: Story = {
  args: {
    thumb: <Avatar kind="placeholder" size={44} />,
    title: "Wireless Earbuds Pro",
    status: "rejected",
    statusLabel: "Rejected",
    meta: "Returned · 1 week ago",
    amount: "₪0.00",
  },
};

export const BuyerRow: Story = {
  args: {
    thumb: <Avatar kind="initial" initial="N" size={38} />,
    title: "Noa bought",
    status: "confirmed",
    statusLabel: "Confirmed",
    meta: "Jun 30",
    amount: "+₪12.40",
    amountSub: "+$3.35",
  },
};

export const Loading: Story = {
  render: () => (
    <div>
      <ActivityRow loading />
      <ActivityRow loading />
      <ActivityRow loading />
    </div>
  ),
};
