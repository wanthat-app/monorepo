import type { Meta, StoryObj } from "@storybook/react";
import { ShareLinkRow } from "../wallet";

const meta: Meta<typeof ShareLinkRow> = {
  title: "Wallet/ShareLinkRow",
  component: ShareLinkRow,
  decorators: [(S) => <div className="w-[420px]"><S /></div>],
};
export default meta;
type Story = StoryObj<typeof ShareLinkRow>;

export const Default: Story = { args: { link: "wnt.ht/Mx7Qa", copyLabel: "Copy" } };
export const Copied: Story = { args: { link: "wnt.ht/Mx7Qa", copyLabel: "Copied ✓" } };
