import type { Meta, StoryObj } from "@storybook/react";
import { Segmented } from "../components";
import { SettingsRow } from "../wallet";

const GLOBE = (
  <svg
    aria-hidden="true"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c2.4 2.6 3.7 5.8 3.7 9s-1.3 6.4-3.7 9c-2.4-2.6-3.7-5.8-3.7-9S9.6 5.6 12 3z" />
  </svg>
);
const LOCK = (
  <svg
    aria-hidden="true"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);
const CARD = (
  <svg
    aria-hidden="true"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="6" width="18" height="13" rx="2" />
    <path d="M3 10h18" />
  </svg>
);

const meta: Meta<typeof SettingsRow> = { title: "Wallet/SettingsRow", component: SettingsRow };
export default meta;
type Story = StoryObj<typeof SettingsRow>;

export const ProfileSettings: Story = {
  render: () => (
    <div className="w-[460px] overflow-hidden rounded-[18px] border border-line bg-surface">
      <SettingsRow
        icon={GLOBE}
        label="Language"
        trailing={
          <Segmented
            value="en"
            onChange={() => {}}
            options={[
              { value: "en", label: "EN" },
              { value: "he", label: "עברית" },
            ]}
          />
        }
      />
      <SettingsRow
        icon={LOCK}
        label="Face ID / passkey"
        trailing={
          <span className="rounded-full bg-accent-soft px-3 py-1 text-xs font-bold text-accent">
            On
          </span>
        }
      />
      <SettingsRow
        icon={CARD}
        tone="base"
        label="Payment method"
        trailing={
          <span className="tabular text-[13px] text-muted" dir="ltr">
            •••• 4821
          </span>
        }
      />
    </div>
  ),
};
