import type { Meta, StoryObj } from "@storybook/react";
import { FeatureRow } from "../wallet";

const CART = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="21" r="1" />
    <circle cx="20" cy="21" r="1" />
    <path d="M1 1h4l2.6 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6" />
  </svg>
);
const SHARE = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
  </svg>
);
const SHIELD = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);

const meta: Meta<typeof FeatureRow> = {
  title: "Wallet/FeatureRow",
  component: FeatureRow,
  decorators: [(S) => <div className="w-[380px]"><S /></div>],
};
export default meta;
type Story = StoryObj<typeof FeatureRow>;

export const ValueProps: Story = {
  render: () => (
    <div className="flex flex-col gap-3.5">
      <FeatureRow icon={CART} title="Earn on every order" subtitle="Shop through wanthat and get real money back" />
      <FeatureRow icon={SHARE} title="Earn from links" subtitle="Share products — earn when friends buy" />
      <FeatureRow icon={SHIELD} title="Withdraw for real" subtitle="Straight to your bank, Bit or PayBox" />
    </div>
  ),
};
