import { test, expect } from "@playwright/test";

test.describe("Settings Members Tab", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    const settingsLink = page.getByRole("link", { name: "Settings" });
    await expect(settingsLink).toHaveAttribute("href", /\/organization\/[a-zA-Z0-9-]+\/settings$/);
    await settingsLink.click();
    await expect(page).toHaveURL(/\/organization\/[a-zA-Z0-9-]+\/settings$/);
    await page.getByRole("button", { name: "Members", exact: true }).click();
  });

  test("should load the members list", async ({ page }) => {
    // There should be a member count badge (e.g., "1 member", CSS uppercases it)
    const membersHeader = page.locator("span.uppercase").filter({ hasText: /member/i });
    await expect(membersHeader).toBeVisible();

    // Verify current user is in the list
    await expect(page.getByText("(you)")).toBeVisible();
  });

  test("should open invite modal and create an invitation", async ({ page }) => {
    const inviteMemberBtn = page.getByRole("button", { name: "Invite Member" });
    await expect(inviteMemberBtn).toBeVisible();
    await inviteMemberBtn.click();

    // Modal should open
    const modalHeading = page.getByRole("heading", { name: "Invite Member" });
    await expect(modalHeading).toBeVisible();

    const emailInput = page.getByPlaceholder("colleague@company.com");
    await expect(emailInput).toBeVisible();

    // Type a dummy email
    const dummyEmail = `test-invite-${Date.now()}@example.com`;
    await emailInput.fill(dummyEmail);

    const sendBtn = page.getByRole("button", { name: "Send Invitation" });
    await expect(sendBtn).not.toBeDisabled();
    await sendBtn.click();

    // Success State
    await expect(page.getByText("Invitation sent!")).toBeVisible();

    // There should be a readonly input with the invite link
    const inviteLinkInput = page.locator("input[readonly]");
    await expect(inviteLinkInput).toBeVisible();
    const linkValue = await inviteLinkInput.inputValue();
    expect(linkValue).toContain("/organizations/join?code=");

    // Close the modal
    const doneBtn = page.getByRole("button", { name: "Done" });
    await doneBtn.click();

    // Modal is closed
    await expect(modalHeading).not.toBeVisible();
  });
});
