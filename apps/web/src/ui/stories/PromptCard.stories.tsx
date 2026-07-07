import type { Meta, StoryObj } from "@storybook/react";
import { PromptCard } from "../wallet";

const FACE_ID = (
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 8V6a2 2 0 0 1 2-2h2" />
    <path d="M16 4h2a2 2 0 0 1 2 2v2" />
    <path d="M20 16v2a2 2 0 0 1-2 2h-2" />
    <path d="M8 20H6a2 2 0 0 1-2-2v-2" />
    <path d="M9 10.5v.5M15 10.5v.5" />
    <path d="M9.5 15a3.5 3.5 0 0 0 5 0" />
  </svg>
);
const LOCK = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

const meta: Meta<typeof PromptCard> = {
  title: "Wallet/PromptCard",
  component: PromptCard,
  decorators: [(S) => <div className="w-[420px]"><S /></div>],
};
export default meta;
type Story = StoryObj<typeof PromptCard>;

export const SetupFaceId: Story = {
  args: {
    icon: FACE_ID,
    title: "Set up Face ID",
    subtitle: "Skip SMS codes — log in instantly next time.",
    actionLabel: "Turn on",
  },
};

export const OtpReassurance: Story = {
  args: {
    icon: LOCK,
    title: "Skip codes next time",
    subtitle: "Turn on Face ID / passkey after sign-in.",
  },
};
