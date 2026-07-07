import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Switch } from "../components";

const meta: Meta<typeof Switch> = { title: "Shared/Switch", component: Switch };
export default meta;
type Story = StoryObj<typeof Switch>;

function Row({ title, sub, initial }: { title: string; sub: string; initial: boolean }) {
  const [on, setOn] = useState(initial);
  return (
    <div className="flex w-[340px] items-center justify-between">
      <div className="flex flex-col">
        <span className="text-[15px] font-semibold text-ink">{title}</span>
        <span className="text-xs text-muted">{sub}</span>
      </div>
      <Switch checked={on} onChange={setOn} label={title} />
    </div>
  );
}

export const On: Story = {
  render: () => (
    <Row
      title="Auto-approve small cashbacks"
      sub="Events under the threshold skip the queue"
      initial
    />
  ),
};

export const Off: Story = {
  render: () => <Row title="Enable PayBox payouts" sub="Instant" initial={false} />,
};
