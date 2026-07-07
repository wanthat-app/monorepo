import type { Meta, StoryObj } from "@storybook/react";
import { Chip } from "../components";
import { BalanceCard } from "../wallet";

const meta: Meta<typeof BalanceCard> = {
  title: "Wallet/BalanceCard",
  component: BalanceCard,
  decorators: [
    (S) => (
      <div className="w-[400px]">
        <S />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof BalanceCard>;

// The Home hero: estimated ILS headline, real per-currency holdings, pending note, mint CTA.
export const Home: Story = {
  args: {
    label: "Available cashback",
    chip: <Chip tone="mint">Estimated</Chip>,
    approx: true,
    amount: "₪142",
    fraction: ".50",
    holdings: ["$36.20", "€2.14"],
    holdingsNote: "held in original currencies",
    pendingNote: "≈₪68.20 pending confirmation",
    cta: "Withdraw cash",
  },
};

// The logged-out landing shows an explicitly-illustrative sample balance — never a real figure.
export const SampleLoggedOut: Story = {
  args: {
    label: "Available cashback",
    chip: <Chip tone="onink">Sample</Chip>,
    amount: "₪142",
    fraction: ".50",
  },
};

export const SignupPitch: Story = {
  render: () => (
    <BalanceCard label="Sign up and you'll earn" amount="₪12.40">
      <div className="-mt-1 flex items-center gap-2 text-[12.5px] leading-[1.4] text-onink-muted">
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-mint" />
        Daniel earns ₪6.20 too — that's how wanthat works.
      </div>
    </BalanceCard>
  ),
};

// Skeleton while the wallet balance loads — same geometry, nothing shifts when data lands.
export const Loading: Story = {
  args: { label: "Available cashback", amount: "", cta: "Withdraw cash", loading: true },
};
