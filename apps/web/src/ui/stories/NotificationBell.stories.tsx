import type { Meta, StoryObj } from "@storybook/react";
import { NotificationBell } from "../admin";

const meta: Meta<typeof NotificationBell> = { title: "Admin/NotificationBell", component: NotificationBell };
export default meta;
type Story = StoryObj<typeof NotificationBell>;

export const WithAlert: Story = { args: { hasAlert: true } };
export const Quiet: Story = { args: { hasAlert: false } };
