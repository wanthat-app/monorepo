import type { Meta, StoryObj } from "@storybook/react";
import { InviteCard } from "../wallet";

const meta: Meta<typeof InviteCard> = {
  title: "Wallet/InviteCard",
  component: InviteCard,
  decorators: [
    (S) => (
      <div className="w-[420px]">
        <S />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof InviteCard>;

export const Default: Story = {
  args: {
    title: "Invite friends, earn together",
    subtitle: "Share your code. You earn cashback on what they buy — they get a welcome reward.",
    code: "wnt.ht/maya",
    copyLabel: "Copy",
  },
};

export const Loading: Story = { args: { loading: true } };
