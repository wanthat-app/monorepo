import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Checkbox } from "../components";

const meta: Meta<typeof Checkbox> = { title: "Shared/Checkbox", component: Checkbox };
export default meta;
type Story = StoryObj<typeof Checkbox>;

export const TermsGate: Story = {
  render: () => {
    const [agreed, setAgreed] = useState(true);
    return (
      <div className="w-[340px]">
        <Checkbox id="terms" checked={agreed} onChange={setAgreed}>
          I agree to the{" "}
          <a href="#terms" className="font-bold text-accent underline">
            Terms of Service
          </a>{" "}
          and{" "}
          <a href="#privacy" className="font-bold text-accent underline">
            Privacy Policy
          </a>
        </Checkbox>
      </div>
    );
  },
};

export const Unchecked: Story = {
  render: () => (
    <div className="w-[340px]">
      <Checkbox id="offers" checked={false} onChange={() => {}}>
        Send me offers and product updates by email
      </Checkbox>
    </div>
  ),
};
