import type { Meta, StoryObj } from "@storybook/react";
import { MerchantStatusChip } from "../admin";

const meta: Meta<typeof MerchantStatusChip> = {
  title: "Admin/MerchantStatusChip",
  component: MerchantStatusChip,
  argTypes: { tone: { control: "select", options: ["confirmed", "awaiting", "declined"] } },
};
export default meta;
type Story = StoryObj<typeof MerchantStatusChip>;

export const Confirmed: Story = { args: { tone: "confirmed", children: "AliExpress confirmed" } };
export const Awaiting: Story = { args: { tone: "awaiting", children: "Awaiting Amazon" } };
export const Declined: Story = { args: { tone: "declined", children: "eBay declined" } };
