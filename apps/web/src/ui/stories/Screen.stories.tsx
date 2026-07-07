import type { Meta, StoryObj } from "@storybook/react";
import { Button, Card, Screen, TextField } from "../components";
import { Logo } from "../brand";

const meta: Meta<typeof Screen> = { title: "Shared/Screen", component: Screen };
export default meta;
type Story = StoryObj<typeof Screen>;

export const PhoneStep: Story = {
  render: () => (
    <Screen>
      <Logo />
      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-[30px] leading-[1.12] tracking-[-0.03em]">Cashback you can trust.</h1>
          <p className="text-[15px] text-secondary">
            Shop AliExpress through wanthat and earn real money back.
          </p>
        </div>
        <TextField label="Phone number" name="phone" type="tel" placeholder="50 123 4567" />
        <Button>Send me a code</Button>
        <Button variant="ghost">Continue as guest — no cashback</Button>
      </Card>
    </Screen>
  ),
};
