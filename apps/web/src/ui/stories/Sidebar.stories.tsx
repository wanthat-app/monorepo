import type { Meta, StoryObj } from "@storybook/react";
import { AdminUserCard, Sidebar, SidebarNavItem, SidebarSection } from "../admin";

const DASH = (
  <svg
    aria-hidden="true"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </svg>
);
const CONFIG = (
  <svg
    aria-hidden="true"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 6h10" />
    <circle cx="17" cy="6" r="2.4" />
    <path d="M20 12H10" />
    <circle cx="7" cy="12" r="2.4" />
    <path d="M4 18h10" />
    <circle cx="17" cy="18" r="2.4" />
  </svg>
);

const meta: Meta<typeof Sidebar> = {
  title: "Admin/Sidebar",
  component: Sidebar,
  decorators: [
    (S) => (
      <div className="h-[560px]">
        <S />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof Sidebar>;

export const Dark: Story = {
  render: () => (
    <Sidebar
      theme="dark"
      footer={
        <AdminUserCard theme="dark" initials="RK" name="Roni Katz" roleLabel="Platform admin" />
      }
    >
      <SidebarSection theme="dark">Overview</SidebarSection>
      <SidebarNavItem theme="dark" icon={DASH} active>
        Dashboard
      </SidebarNavItem>
      <SidebarSection theme="dark">Settings</SidebarSection>
      <SidebarNavItem theme="dark" icon={CONFIG}>
        Configuration
      </SidebarNavItem>
    </Sidebar>
  ),
};

export const Light: Story = {
  render: () => (
    <Sidebar
      theme="light"
      footer={
        <AdminUserCard theme="light" initials="RK" name="Roni Katz" roleLabel="Platform admin" />
      }
    >
      <SidebarSection theme="light">Overview</SidebarSection>
      <SidebarNavItem theme="light" icon={DASH} active>
        Dashboard
      </SidebarNavItem>
      <SidebarSection theme="light">Settings</SidebarSection>
      <SidebarNavItem theme="light" icon={CONFIG}>
        Configuration
      </SidebarNavItem>
    </Sidebar>
  ),
};
