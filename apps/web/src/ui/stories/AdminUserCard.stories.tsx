import type { Meta, StoryObj } from "@storybook/react";
import { AdminUserCard } from "../admin";

const meta: Meta<typeof AdminUserCard> = {
  title: "Admin/AdminUserCard",
  component: AdminUserCard,
  decorators: [(S) => <div className="w-[240px]"><S /></div>],
};
export default meta;
type Story = StoryObj<typeof AdminUserCard>;

export const OnDark: Story = {
  args: { theme: "dark", initials: "RK", name: "Roni Katz", role: "Platform admin" },
  decorators: [(S) => <div className="rounded-card bg-ink p-4"><S /></div>],
};

export const OnLight: Story = {
  args: { theme: "light", initials: "RK", name: "Roni Katz", role: "Platform admin" },
};
