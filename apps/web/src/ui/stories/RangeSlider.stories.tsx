import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { RangeSlider } from "../components";

const meta: Meta<typeof RangeSlider> = { title: "Shared/RangeSlider", component: RangeSlider };
export default meta;
type Story = StoryObj<typeof RangeSlider>;

export const MarginRate: Story = {
  render: () => {
    const [v, setV] = useState(35);
    return (
      <div className="w-[380px]">
        <RangeSlider value={v} min={0} max={90} onChange={setV} label="Operating margin rate" format={(x) => `${x}%`} />
      </div>
    );
  },
};

export const ReferrerSplit: Story = {
  render: () => {
    const [v, setV] = useState(70);
    return (
      <div className="w-[380px]">
        <RangeSlider value={v} min={0} max={100} step={5} onChange={setV} label="Referrer–buyer split" format={(x) => `${x}/${100 - x}`} />
      </div>
    );
  },
};
