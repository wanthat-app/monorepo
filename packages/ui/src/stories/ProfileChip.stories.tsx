import type { Meta, StoryObj } from "@storybook/react";
import { ProfileChip } from "../wallet";

const meta: Meta<typeof ProfileChip> = { title: "Wallet/ProfileChip", component: ProfileChip };
export default meta;
type Story = StoryObj<typeof ProfileChip>;

export const Default: Story = { args: { initial: "M", label: "Maya Levi" } };
export const NavSize: Story = { args: { initial: "M", size: 36 } };
export const ProfileHeader: Story = { args: { initial: "M", size: 72 } };
