import type { Meta, StoryObj } from "@storybook/react";
import { BrandMark } from "../brand";

const meta: Meta<typeof BrandMark> = { title: "Brand/BrandMark", component: BrandMark };
export default meta;
type Story = StoryObj<typeof BrandMark>;

export const Default: Story = { args: { height: 30 } };
export const NavSize: Story = { args: { height: 22 } };
export const Large: Story = { args: { height: 42 } };
