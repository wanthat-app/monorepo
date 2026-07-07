import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { PillTabs } from "../wallet";

const meta: Meta<typeof PillTabs> = { title: "Wallet/PillTabs", component: PillTabs };
export default meta;
type Story = StoryObj<typeof PillTabs>;

export const ActivityFilters: Story = {
  render: () => {
    const [v, setV] = useState("all");
    return (
      <div className="w-[420px]">
        <PillTabs
          value={v}
          onChange={setV}
          options={[
            { value: "all", label: "All" },
            { value: "confirmed", label: "Confirmed" },
            { value: "pending", label: "Pending" },
            { value: "rejected", label: "Rejected" },
          ]}
        />
      </div>
    );
  },
};

export const MerchantFilter: Story = {
  render: () => {
    const [v, setV] = useState("all");
    return (
      <div className="w-[520px]">
        <PillTabs
          value={v}
          onChange={setV}
          options={[
            { value: "all", label: "All merchants" },
            { value: "ali", label: "AliExpress" },
            { value: "amazon", label: "Amazon" },
            { value: "shein", label: "Shein" },
            { value: "ebay", label: "eBay" },
          ]}
        />
      </div>
    );
  },
};
