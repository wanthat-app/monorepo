import type { Meta, StoryObj } from "@storybook/react";
import { CountingChip, CountingHero, LastCountedChip } from "../counting";
import { BalanceCard } from "../wallet";

const meta: Meta<typeof BalanceCard> = {
  title: "Wallet/Counting",
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

// Cold start, layout "chip": counting pill in the header, stale amount breathing.
export const ChipCoin: Story = {
  args: {
    label: "Available cashback",
    chip: <CountingChip glyph="coin" label="Counting the money…" />,
    stale: true,
    approx: true,
    amount: "₪142",
    fraction: ".50",
    holdings: ["$36.20", "€2.14"],
    cta: "Withdraw cash",
  },
};

// Cold start, layout "hero": the machine takes the amount slot; last total drops to a chip.
export const HeroMachine: Story = {
  args: {
    label: "Available cashback",
    amountSlot: <CountingHero glyph="machine" label="Counting the money…" />,
    holdingsSlot: <LastCountedChip>Last counted: ≈₪142.50</LastCountedChip>,
    cta: "Withdraw cash",
  },
};

// The on-surface chip used on activity section headers (white background).
export const SurfaceChip: Story = {
  render: () => <CountingChip glyph="machine" label="Counting the money…" tone="onSurface" />,
};
