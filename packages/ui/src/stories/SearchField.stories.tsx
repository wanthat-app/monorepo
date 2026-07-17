import type { Meta, StoryObj } from "@storybook/react";
import { SearchField } from "../admin";

const meta: Meta<typeof SearchField> = { title: "Admin/SearchField", component: SearchField };
export default meta;
type Story = StoryObj<typeof SearchField>;

export const Default: Story = { args: { placeholder: "Search users, links, payouts…" } };
