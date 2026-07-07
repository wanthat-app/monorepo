import type { Meta, StoryObj } from "@storybook/react";
import { ApprovalRow, MerchantStatusChip } from "../admin";
import feeder from "../assets/product-feeder.jpg";
import { Avatar } from "../wallet";

const meta: Meta<typeof ApprovalRow> = {
  title: "Admin/ApprovalRow",
  component: ApprovalRow,
  decorators: [
    (S) => (
      <div className="w-[640px] rounded-card border border-line bg-surface">
        <S />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof ApprovalRow>;

export const Queue: Story = {
  render: () => (
    <div>
      <ApprovalRow
        thumb={<Avatar kind="product" src={feeder} size={40} />}
        product="Jebao Smart Aquarium Fish Feeder"
        user="Maya L."
        when="2h ago"
        status={<MerchantStatusChip tone="confirmed">AliExpress confirmed</MerchantStatusChip>}
        amount="₪12.40"
      />
      <ApprovalRow
        thumb={<Avatar kind="placeholder" size={40} />}
        product="USB-C 7-in-1 Hub"
        user="Omer D."
        when="5h ago"
        status={<MerchantStatusChip tone="awaiting">Awaiting Amazon</MerchantStatusChip>}
        amount="₪3.10"
      />
      <ApprovalRow
        thumb={<Avatar kind="placeholder" size={40} />}
        product="Wireless Earbuds Pro"
        user="Noa B."
        when="1d ago"
        status={<MerchantStatusChip tone="declined">eBay declined</MerchantStatusChip>}
        amount="₪7.90"
      />
    </div>
  ),
};
