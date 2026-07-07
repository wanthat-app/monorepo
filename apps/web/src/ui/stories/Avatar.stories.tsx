import type { Meta, StoryObj } from "@storybook/react";
import feeder from "../assets/product-feeder.jpg";
import { Avatar } from "../wallet";

const meta: Meta<typeof Avatar> = {
  title: "Wallet/Avatar",
  component: Avatar,
  argTypes: { kind: { control: "select", options: ["initial", "product", "placeholder"] } },
};
export default meta;
type Story = StoryObj<typeof Avatar>;

export const Initial: Story = { args: { kind: "initial", initial: "M" } };
export const Product: Story = { args: { kind: "product", src: feeder, alt: "Jebao Fish Feeder" } };
export const Placeholder: Story = { args: { kind: "placeholder" } };
