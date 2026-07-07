import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { MethodRow } from "../wallet";

const meta: Meta<typeof MethodRow> = {
  title: "Wallet/MethodRow",
  component: MethodRow,
  decorators: [
    (S) => (
      <div className="w-[420px]">
        <S />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof MethodRow>;

// The withdraw screen's payout-method picker: Bank/Card show a generic glyph until details are
// saved; Bit/PayBox use the verified phone with no setup.
export const Picker: Story = {
  render: () => {
    const [sel, setSel] = useState("bit");
    return (
      <div>
        <MethodRow
          brand="bank"
          label="Bank account"
          detail="Add details"
          selected={sel === "bank"}
          onSelect={() => setSel("bank")}
        />
        <MethodRow
          brand="card"
          label="Credit card"
          detail="Add details"
          selected={sel === "card"}
          onSelect={() => setSel("card")}
        />
        <MethodRow
          brand="bit"
          label="Bit"
          detail="+972 50 123 4567"
          selected={sel === "bit"}
          onSelect={() => setSel("bit")}
        />
        <MethodRow
          brand="paybox"
          label="PayBox"
          detail="+972 50 123 4567"
          selected={sel === "paybox"}
          onSelect={() => setSel("paybox")}
        />
      </div>
    );
  },
};

export const SavedBankSelected: Story = {
  args: {
    brand: "bank",
    label: "Bank account",
    detail: "Bank Hapoalim · •••• 4821",
    selected: true,
  },
};
