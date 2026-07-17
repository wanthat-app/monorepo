import type { Meta, StoryObj } from "@storybook/react";
import { Skeleton, SkeletonCircle } from "../components";

const meta: Meta<typeof Skeleton> = { title: "Shared/Skeleton", component: Skeleton };
export default meta;
type Story = StoryObj<typeof Skeleton>;

// The raw placeholder blocks data-bearing components compose while `loading` is set.
export const TextBlock: Story = {
  render: () => (
    <div className="flex w-[340px] flex-col gap-2">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-3.5 w-full" />
      <Skeleton className="h-3.5 w-1/2" />
    </div>
  ),
};

export const MediaRow: Story = {
  render: () => (
    <div className="flex w-[340px] items-center gap-3">
      <SkeletonCircle size={44} />
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  ),
};

export const OnInk: Story = {
  render: () => (
    <div className="flex w-[340px] flex-col gap-2 rounded-card bg-ink p-5">
      <Skeleton onInk className="h-4 w-2/3" />
      <Skeleton onInk className="h-3.5 w-full" />
    </div>
  ),
};
