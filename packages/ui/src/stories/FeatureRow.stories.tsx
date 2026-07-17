import type { Meta, StoryObj } from "@storybook/react";
import { CartIcon, ShareNodesIcon, ShieldIcon } from "../icons";
import { FeatureRow } from "../wallet";

const CART = <CartIcon />;
const SHARE = <ShareNodesIcon />;
const SHIELD = <ShieldIcon />;

const meta: Meta<typeof FeatureRow> = {
  title: "Wallet/FeatureRow",
  component: FeatureRow,
  decorators: [
    (S) => (
      <div className="w-[380px]">
        <S />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof FeatureRow>;

export const ValueProps: Story = {
  render: () => (
    <div className="flex flex-col gap-3.5">
      <FeatureRow
        icon={CART}
        title="Earn on every order"
        subtitle="Shop through wanthat and get real money back"
      />
      <FeatureRow
        icon={SHARE}
        title="Earn from links"
        subtitle="Share products — earn when friends buy"
      />
      <FeatureRow
        icon={SHIELD}
        title="Withdraw for real"
        subtitle="Straight to your bank, Bit or PayBox"
      />
    </div>
  ),
};

export const Loading: Story = {
  render: () => (
    <div className="flex flex-col gap-3.5">
      <FeatureRow loading />
      <FeatureRow loading />
      <FeatureRow loading />
    </div>
  ),
};
