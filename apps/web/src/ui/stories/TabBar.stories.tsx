import type { Meta, StoryObj } from "@storybook/react";
import { TabBar } from "../wallet";

const meta: Meta<typeof TabBar> = {
  title: "Wallet/TabBar",
  component: TabBar,
  decorators: [
    (S) => (
      <div className="w-[390px] rounded-b-card bg-page pt-6">
        <S />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof TabBar>;

export const HomeActive: Story = {
  args: { homeLabel: "Home", activityLabel: "Activity", active: "home", createLabel: "Create" },
};

export const ActivityActive: Story = {
  args: { homeLabel: "Home", activityLabel: "Activity", active: "activity", createLabel: "Create" },
};

export const Hebrew: Story = {
  render: () => (
    <div dir="rtl">
      <TabBar homeLabel="בית" activityLabel="פעילות" active="home" createLabel="יצירה" />
    </div>
  ),
};
