import type { Meta, StoryObj } from "@storybook/react";
import { SaveBar } from "../admin";

const meta: Meta<typeof SaveBar> = {
  title: "Admin/SaveBar",
  component: SaveBar,
  decorators: [
    (S) => (
      <div className="w-[720px]">
        <S />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof SaveBar>;

export const Dirty: Story = { args: { dirty: true } };
export const Saved: Story = { args: { dirty: false, saved: true } };
export const Clean: Story = { args: { dirty: false } };
