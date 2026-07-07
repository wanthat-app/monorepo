import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { MethodToggleRow } from "../admin";

const BANK = (
  <svg
    aria-hidden="true"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 21h18" />
    <path d="M5 21V10M19 21V10M9 21V10M15 21V10" />
    <path d="M12 3 21 8H3z" />
  </svg>
);
const CARD = (
  <svg
    aria-hidden="true"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="2" y="5" width="20" height="14" rx="2.5" />
    <path d="M2 10h20" />
  </svg>
);

const meta: Meta<typeof MethodToggleRow> = {
  title: "Admin/MethodToggleRow",
  component: MethodToggleRow,
};
export default meta;
type Story = StoryObj<typeof MethodToggleRow>;

export const PayoutMethods: Story = {
  render: () => {
    const [bank, setBank] = useState(true);
    const [card, setCard] = useState(true);
    const [bit, setBit] = useState(true);
    const [paybox, setPaybox] = useState(false);
    return (
      <div className="grid w-[640px] grid-cols-2 gap-3">
        <MethodToggleRow
          icon={BANK}
          label="Bank transfer"
          eta="1–2 business days"
          checked={bank}
          onChange={setBank}
        />
        <MethodToggleRow
          icon={CARD}
          label="Debit card"
          eta="Instant"
          checked={card}
          onChange={setCard}
        />
        <MethodToggleRow
          icon={<span className="text-[13px] font-extrabold">bit</span>}
          label="Bit"
          eta="Instant"
          checked={bit}
          onChange={setBit}
        />
        <MethodToggleRow
          icon={<span className="text-[10px] font-extrabold">PayBox</span>}
          label="PayBox"
          eta="Instant"
          checked={paybox}
          onChange={setPaybox}
        />
      </div>
    );
  },
};
