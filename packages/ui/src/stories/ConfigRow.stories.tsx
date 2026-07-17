import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { ConfigRow } from "../admin";
import { RangeSlider, Segmented, Switch } from "../components";

const meta: Meta<typeof ConfigRow> = {
  title: "Admin/ConfigRow",
  component: ConfigRow,
  decorators: [
    (S) => (
      <div className="w-[720px] rounded-card border border-line bg-surface px-6 py-1">
        <S />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof ConfigRow>;

export const MarginsSection: Story = {
  render: () => {
    const [margin, setMargin] = useState(35);
    const [currency, setCurrency] = useState("ils");
    const [auto, setAuto] = useState(true);
    return (
      <div>
        <ConfigRow
          title="Operating margin rate"
          description="wanthat's share of affiliate commission, kept before rewards are paid."
        >
          <div className="w-[300px]">
            <RangeSlider
              value={margin}
              min={0}
              max={90}
              onChange={setMargin}
              label="Operating margin rate"
              format={(v) => `${v}%`}
            />
          </div>
        </ConfigRow>
        <ConfigRow title="Payout currency" description="Figures stay LTR with the symbol leading.">
          <Segmented
            value={currency}
            onChange={setCurrency}
            options={[
              { value: "ils", label: "₪ ILS" },
              { value: "usd", label: "$ USD" },
              { value: "eur", label: "€ EUR" },
            ]}
          />
        </ConfigRow>
        <ConfigRow
          title="Auto-approve small cashbacks"
          description="Events under the threshold skip the approvals queue."
        >
          <Switch checked={auto} onChange={setAuto} label="Auto-approve small cashbacks" />
        </ConfigRow>
      </div>
    );
  },
};
