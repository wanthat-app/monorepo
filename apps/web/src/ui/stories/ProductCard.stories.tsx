import type { Meta, StoryObj } from "@storybook/react";
import feeder from "../assets/product-feeder.jpg";
import { ProductCard } from "../wallet";

const meta: Meta<typeof ProductCard> = {
  title: "Wallet/ProductCard",
  component: ProductCard,
  decorators: [
    (S) => (
      <div className="w-[400px]">
        <S />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof ProductCard>;

export const SharedProduct: Story = {
  args: {
    src: feeder,
    title: "Jebao Smart Aquarium Fish Feeder",
    price: "₪95.21",
    priceNote: "on AliExpress",
    meta: "★ 4.7 · 1.8k sold",
  },
};
