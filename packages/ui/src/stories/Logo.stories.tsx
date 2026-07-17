import type { Meta, StoryObj } from "@storybook/react";
import { Logo } from "../brand";

const meta: Meta<typeof Logo> = {
  title: "Brand/Logo",
  component: Logo,
  argTypes: { size: { control: "select", options: ["sm", "md", "lg"] } },
};
export default meta;
type Story = StoryObj<typeof Logo>;

export const Default: Story = { args: { size: "lg" } };
export const Small: Story = { args: { size: "sm" } };
export const WithCaption: Story = { args: { size: "lg", caption: "Operations" } };
