import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Segmented } from "../components";

const meta: Meta<typeof Segmented> = { title: "Shared/Segmented", component: Segmented };
export default meta;
type Story = StoryObj<typeof Segmented>;

function Demo({ options, initial }: { options: { value: string; label: string }[]; initial: string }) {
  const [value, setValue] = useState(initial);
  return <Segmented options={options} value={value} onChange={setValue} />;
}

export const Language: Story = {
  render: () => (
    <Demo
      initial="en"
      options={[
        { value: "en", label: "English" },
        { value: "he", label: "עברית" },
      ]}
    />
  ),
};

export const OtpChannel: Story = {
  render: () => (
    <Demo
      initial="whatsapp"
      options={[
        { value: "whatsapp", label: "WhatsApp" },
        { value: "sms", label: "SMS" },
      ]}
    />
  ),
};

export const Currency: Story = {
  render: () => (
    <Demo
      initial="ils"
      options={[
        { value: "ils", label: "₪ ILS" },
        { value: "usd", label: "$ USD" },
        { value: "eur", label: "€ EUR" },
      ]}
    />
  ),
};
