import type { Meta, StoryObj } from "@storybook/react";
import { AttributionChip, RecommendationQuote } from "../wallet";

const meta: Meta<typeof AttributionChip> = {
  title: "Wallet/AttributionChip",
  component: AttributionChip,
  decorators: [(S) => <div className="w-[380px]"><S /></div>],
};
export default meta;
type Story = StoryObj<typeof AttributionChip>;

export const SentLink: Story = {
  args: {
    initial: "D",
    children: (
      <>
        <strong className="font-bold text-ink">Daniel</strong> sent you a cashback link
      </>
    ),
  },
};

export const WithRecommendation: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      <AttributionChip initial="D">
        <strong className="font-bold text-ink">Daniel</strong> recommended you a product
      </AttributionChip>
      <RecommendationQuote>
        Been using this feeder for 3 months — super reliable, my fish are fed even when I travel.
        Worth every shekel.
      </RecommendationQuote>
    </div>
  ),
};
