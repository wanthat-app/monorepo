import type { Meta, StoryObj } from "@storybook/react";
import { IconTile } from "../components";

const FACE_ID = (
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 8V6a2 2 0 0 1 2-2h2" />
    <path d="M16 4h2a2 2 0 0 1 2 2v2" />
    <path d="M20 16v2a2 2 0 0 1-2 2h-2" />
    <path d="M8 20H6a2 2 0 0 1-2-2v-2" />
    <path d="M9 10.5v.5M15 10.5v.5" />
    <path d="M9.5 15a3.5 3.5 0 0 0 5 0" />
  </svg>
);

const meta: Meta<typeof IconTile> = {
  title: "Shared/IconTile",
  component: IconTile,
  argTypes: { tone: { control: "select", options: ["accent", "soft", "base"] } },
};
export default meta;
type Story = StoryObj<typeof IconTile>;

export const Accent: Story = { args: { tone: "accent", children: FACE_ID } };
export const Soft: Story = { args: { tone: "soft", children: FACE_ID } };
export const Small: Story = { args: { tone: "base", size: 34, children: FACE_ID } };
