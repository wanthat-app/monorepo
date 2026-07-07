import type { Meta, StoryObj } from "@storybook/react";
import { RecommendationQuote } from "../wallet";

const meta: Meta<typeof RecommendationQuote> = {
  title: "Wallet/RecommendationQuote",
  component: RecommendationQuote,
  decorators: [(S) => <div className="w-[380px]"><S /></div>],
};
export default meta;
type Story = StoryObj<typeof RecommendationQuote>;

export const Default: Story = {
  args: {
    children:
      "Been using this feeder for 3 months — super reliable, my fish are fed even when I travel. Worth every shekel.",
  },
};

export const Rtl: Story = {
  render: () => (
    <div dir="rtl">
      <RecommendationQuote>
        אני משתמש במאכיל הזה כבר שלושה חודשים — אמין ממש, הדגים שלי מקבלים אוכל גם כשאני בנסיעות.
      </RecommendationQuote>
    </div>
  ),
};
