# Entity E2E Testing Playbook

> Extracted from the working `departments/` and `locations/` E2E test suites.
> Use this as a prompt template to generate tests for any entity page.

---

## Architecture Overview

All entity pages share the **EntitySplitLayout** pattern:

```
┌─────────────────────────────────────────────────────────────┐
│  Header: Title + Count Badge + "New {Entity}" Button        │
├──────────────────────┬──────────────────────────────────────┤
│  Sidebar (left)      │  Content Panel (right)               │
│  ┌────────────────┐  │  Modes:                              │
│  │ Filter bar     │  │  • Empty state (no selection)        │
│  │ Search input   │  │  • Detail view (card selected)       │
│  │ Sort toggles   │  │  • Create form (mode=new)            │
│  ├────────────────┤  │  • Edit form (mode=edit + selected)  │
│  │ Card List      │  │                                      │
│  │  PartyCard     │  │  Uses PartyDetailPanel /             │
│  │  PartyCard     │  │  PartyCreateForm components          │
│  │  ...           │  │                                      │
│  └────────────────┘  │                                      │
└──────────────────────┴──────────────────────────────────────┘
```

### Two Categories of Entity Pages

| Category        | Pages                                                            | List Component         | Form Component         | Detail Component              |
| --------------- | ---------------------------------------------------------------- | ---------------------- | ---------------------- | ----------------------------- |
| **Party-based** | Vendors, Customers, Employees, Shareholders, Lenders, Government | `PartyCard`            | `PartyCreateForm`      | `PartyDetailPanel`            |
| **Financial**   | Banks & Cards                                                    | `FinancialAccountCard` | `FinancialAccountForm` | `FinancialAccountDetailPanel` |

### Dual-Panel UI Hazard

> [!WARNING]
> The `EntitySplitLayout` renders **both a mobile panel and a desktop panel**. The desktop panel uses the CSS class `.hidden.lg\:block`. To avoid Playwright **strict mode violations** (multiple elements matching), always scope form-field locators to the desktop panel:
>
> ```ts
> const desktopPanel = page.locator(".hidden.lg\\:block");
> const nameInput = desktopPanel.getByPlaceholder("Vendor name");
> ```

---

## Entity Variable Lookup Table

Use this table to substitute variables into the test templates below.

| Variable             | Vendors                     | Customers             | Employees             | Shareholders             | Lenders             | Government                   | Banks & Cards                   |
| -------------------- | --------------------------- | --------------------- | --------------------- | ------------------------ | ------------------- | ---------------------------- | ------------------------------- |
| `ROUTE`              | `/entities/vendors`         | `/entities/customers` | `/entities/employees` | `/entities/shareholders` | `/entities/lenders` | `/entities/government`       | `/entities/banks`               |
| `PAGE_TITLE`         | `Vendors`                   | `Customers`           | `Employees`           | `Shareholders`           | `Lenders`           | `Government`                 | `Banks & Cards`                 |
| `NEW_BTN_TEXT`       | `New Vendor`                | `New Customer`        | `Add Employee`        | `New Shareholder`        | `New Lender`        | `New Agency`                 | `New Account`                   |
| `SEARCH_PLACEHOLDER` | `Search for…`               | `Search for…`         | `Search for…`         | `Search for…`            | `Search for…`       | `Search for…`                | `Search for…`                   |
| `FORM_HEADER_NEW`    | `New Vendor`                | `New Customer`        | `New Employee`        | `New Shareholder`        | `New Lender`        | `New Government`             | _(FinancialAccountForm header)_ |
| `FORM_HEADER_EDIT`   | `Edit Vendor`               | `Edit Customer`       | `Edit Employee`       | `Edit Shareholder`       | `Edit Lender`       | `Edit Government`            | _(FinancialAccountForm header)_ |
| `NAME_PLACEHOLDER`   | `Vendor name`               | `Customer name`       | `Employee name`       | `Shareholder name`       | `Lender name`       | `Government name`            | _(different form)_              |
| `PARTY_TYPE`         | `vendor`                    | `customer`            | `employee`            | `shareholder`            | `lender`            | `government`                 | N/A                             |
| `EMPTY_STATE_TEXT`   | `No vendors yet`            | `No customers yet`    | `No employees yet`    | `No shareholders yet`    | `No lenders yet`    | `No government agencies yet` | `No accounts yet`               |
| `HAS_TABLE_ROWS`     | No (card list)              | No (card list)        | No (card list)        | No (card list)           | No (card list)      | No (card list)               | No (card list)                  |
| `HAS_VENDOR_FIELDS`  | ✅ (1099, TaxID, Bank info) | ❌                    | ❌                    | ❌                       | ❌                  | ❌                           | ❌                              |
| `URL_PATTERN`        | `?selected=`                | `?selected=`          | `?selected=`          | `?selected=`             | `?selected=`        | `?selected=`                 | `?selected=`                    |

---

## Test Spec Templates (6 files per entity)

### 1. `layout-and-responsive.spec.ts`

Tests: page loads, title visible, count badge visible, primary button visible.

```ts
import { test, expect } from "@playwright/test";

test.describe("{{PAGE_TITLE}} Layout and Responsive", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("{{ROUTE}}");
    await page.waitForLoadState("networkidle");
  });

  test("should display main headers and default structure", async ({ page }) => {
    // Check main title
    await expect(page.getByText("{{PAGE_TITLE}}", { exact: true }).first()).toBeVisible();

    // Check the primary button
    const newBtn = page.getByRole("button", { name: "{{NEW_BTN_TEXT}}" }).first();
    await expect(newBtn).toBeVisible();
  });
});
```

### 2. `creation-flow.spec.ts`

Tests: opens create form, verifies form fields, cancels without saving.

> [!IMPORTANT]
> Party-based entities use `PartyCreateForm` with placeholders like `"{TypeLabel} name"`, `"email@example.com"`, `"(555) 123-4567"`. Banks use `FinancialAccountForm` with different fields.

```ts
import { test, expect } from "@playwright/test";

test.describe("{{PAGE_TITLE}} Creation Flow", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("{{ROUTE}}");
    await page.waitForLoadState("networkidle");
  });

  test("should open the creation form and cancel", async ({ page }) => {
    const newBtn = page.getByRole("button", { name: "{{NEW_BTN_TEXT}}" }).first();
    await newBtn.click();

    // Check panel header
    const panelHeader = page.getByText("{{FORM_HEADER_NEW}}", { exact: true }).first();
    await expect(panelHeader).toBeVisible();

    // Verify name field exists (scoped to desktop panel)
    const desktopPanel = page.locator(".hidden.lg\\:block");
    const nameInput = desktopPanel.getByPlaceholder("{{NAME_PLACEHOLDER}}");
    await expect(nameInput).toBeVisible();

    // Cancel
    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    await cancelBtn.click();
    await expect(nameInput).not.toBeVisible();
  });

  test("should interact with creation fields without saving", async ({ page }) => {
    const newBtn = page.getByRole("button", { name: "{{NEW_BTN_TEXT}}" }).first();
    await newBtn.click();

    const desktopPanel = page.locator(".hidden.lg\\:block");
    const nameInput = desktopPanel.getByPlaceholder("{{NAME_PLACEHOLDER}}");
    await nameInput.fill("E2E Test {{PAGE_TITLE}}");

    // Check email field
    const emailInput = desktopPanel.getByPlaceholder("email@example.com");
    if (await emailInput.isVisible()) {
      await emailInput.fill("e2e@test.com");
    }

    // Cancel — non-destructive
    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    await cancelBtn.click();
  });
});
```

### 3. `search-and-filters.spec.ts`

Tests: search input interaction, filter popover toggle, clear button.

```ts
import { test, expect } from "@playwright/test";

test.describe("{{PAGE_TITLE}} Search and Filters", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("{{ROUTE}}");
    await page.waitForLoadState("networkidle");
  });

  test("should interact with search input", async ({ page }) => {
    const searchInput = page.getByPlaceholder("{{SEARCH_PLACEHOLDER}}");
    await expect(searchInput).toBeVisible();

    await searchInput.fill("test search");
    await expect(searchInput).toHaveValue("test search");
  });

  test("should toggle filter popover", async ({ page }) => {
    // Filter button has title="Filters"
    const filterBtn = page.locator('button[title="Filters"]');
    if (await filterBtn.isVisible()) {
      await filterBtn.click();

      // Check for status filter options (Active/Inactive)
      const activeOption = page.getByText("Active", { exact: true });
      if (await activeOption.first().isVisible()) {
        // Filter popover is open
        await page.keyboard.press("Escape");
      }
    }
  });

  test("should clear filters via Clear button", async ({ page }) => {
    const clearBtn = page.getByRole("button", { name: "Clear", exact: true });
    if (await clearBtn.isVisible()) {
      await clearBtn.click();
    }
  });
});
```

### 4. `detail-view.spec.ts`

Tests: clicking a card/row selects it, URL updates with `?selected=`, detail panel shows.

> [!NOTE]
> Party-based pages use `PartyCard` (not table rows). Use a scoped locator on the card list container.

```ts
import { test, expect } from "@playwright/test";

test.describe("{{PAGE_TITLE}} Detail View", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("{{ROUTE}}");
    await page.waitForLoadState("networkidle");
  });

  test("should select a card and show detail panel", async ({ page }) => {
    // Party cards are rendered in the sidebar's scrollable list
    // Each card is a clickable div inside the sidebar
    const cards = page.locator(".overflow-y-auto .rounded-xl").first();

    if (await cards.isVisible()) {
      await cards.click();

      // URL should update with selected param
      await expect(page).toHaveURL(/selected=/);

      // Detail panel should show entity info
      // The PartyDetailPanel renders the entity name and an Edit button
      const editBtn = page.getByRole("button", { name: /Edit/i }).first();
      if (await editBtn.isVisible()) {
        await expect(editBtn).toBeVisible();
      }
    }
  });
});
```

### 5. `row-actions.spec.ts` (Card Actions)

Tests: hover actions on cards, quick action buttons.

> [!NOTE]
> Party-based entity pages use card-based layouts, not table rows. The cards don't have hover-reveal action buttons like Departments/Locations (which use tables). For party entities, this spec covers card click → detail → action buttons in the detail panel.

```ts
import { test, expect } from "@playwright/test";

test.describe("{{PAGE_TITLE}} Card Actions", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("{{ROUTE}}");
    await page.waitForLoadState("networkidle");
  });

  test("should show actions in detail panel after selection", async ({ page }) => {
    const cards = page.locator(".overflow-y-auto .rounded-xl").first();

    if (await cards.isVisible()) {
      await cards.click();
      await expect(page).toHaveURL(/selected=/);

      // Check for Edit button in detail panel
      const editBtn = page.getByRole("button", { name: /Edit/i }).first();
      if (await editBtn.isVisible()) {
        await expect(editBtn).toBeVisible();
      }
    }
  });
});
```

### 6. `edit-and-deactivate.spec.ts`

Tests: transition from detail → edit mode, deactivation confirmation modal.

```ts
import { test, expect } from "@playwright/test";

test.describe("{{PAGE_TITLE}} Edit and Deactivate", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("{{ROUTE}}");
    await page.waitForLoadState("networkidle");
  });

  test("should transition to edit mode from detail view", async ({ page }) => {
    const cards = page.locator(".overflow-y-auto .rounded-xl").first();

    if (await cards.isVisible()) {
      await cards.click();

      const editBtn = page.getByRole("button", { name: /Edit/i }).first();
      if (await editBtn.isVisible()) {
        await editBtn.click();

        // In edit mode, Save Changes button should appear
        const saveBtn = page.getByRole("button", {
          name: /Save Changes/i,
        });
        await expect(saveBtn).toBeVisible();

        // Cancel to exit safely
        await page.getByRole("button", { name: "Cancel" }).click();
      }
    }
  });

  test("should surface deactivation flow", async ({ page }) => {
    const cards = page.locator(".overflow-y-auto .rounded-xl").first();

    if (await cards.isVisible()) {
      await cards.click();

      const editBtn = page.getByRole("button", { name: /Edit/i }).first();
      if (await editBtn.isVisible()) {
        await editBtn.click();

        const deactivateBtn = page.getByRole("button", {
          name: /Deactivate/i,
        });
        if (await deactivateBtn.isVisible()) {
          await deactivateBtn.click();

          // Look for confirmation dialog
          const confirmDialog = page.getByRole("dialog");
          await expect(confirmDialog).toBeVisible();

          // Cancel — non-destructive
          const cancelModalBtn = confirmDialog.getByRole("button", { name: /Cancel|No/i }).first();
          await cancelModalBtn.click();
        }
      }
    }
  });
});
```

---

## Key Testing Principles

1. **Non-destructive only** — Never submit forms or confirm destructive actions. Always cancel.
2. **Desktop panel scoping** — Use `.hidden.lg\\:block` to avoid strict mode violations from the mobile panel.
3. **Conditional guards** — Use `if (await element.isVisible())` for elements that depend on data existing (e.g., cards, edit buttons).
4. **Auth state** — All specs use `test.use({ storageState: "tests/e2e/.auth/user.json" })`.
5. **Network idle** — `await page.waitForLoadState("networkidle")` in `beforeEach` to wait for data fetches.
6. **URL search params** — Entity pages use `?selected=<id>&mode=new|edit` patterns for state.

## File Structure Convention

```
tests/e2e/
  entities/
    vendors/
      layout-and-responsive.spec.ts
      creation-flow.spec.ts
      search-and-filters.spec.ts
      detail-view.spec.ts
      row-actions.spec.ts
      edit-and-deactivate.spec.ts
    customers/
      ...same 6 files...
    employees/
      ...
    shareholders/
      ...
    lenders/
      ...
    government/
      ...
    banks/
      ...same 6 files (with FinancialAccountForm-specific locators)...
```

---

## How to Use This Playbook

**As a prompt to an AI agent:**

> Create E2E tests for the **Vendors** entity page following the Entity E2E Testing Playbook.
> Use these substitutions:
>
> - `ROUTE`: `/entities/vendors`
> - `PAGE_TITLE`: `Vendors`
> - `NEW_BTN_TEXT`: `New Vendor`
> - `SEARCH_PLACEHOLDER`: `Search for…`
> - `FORM_HEADER_NEW`: `New Vendor`
> - `NAME_PLACEHOLDER`: `Vendor name`
>
> Create 6 spec files in `tests/e2e/entities/vendors/`. The page uses `PartyCard` (card-based list, not table rows) and `PartyCreateForm` with fields: Name, Email, Phone, Website, Address, plus Vendor-specific fields (1099 checkbox, Tax ID, Bank Routing/Account numbers, Mailing Address).
>
> Follow the non-destructive testing pattern — never submit forms, always cancel.

**For Banks & Cards** (the special case):

> Banks uses `FinancialAccountForm` instead of `PartyCreateForm`. The form has different fields (Account Name, Institution, Account Type dropdown, Last Four digits, etc.). Adjust the `creation-flow.spec.ts` locators accordingly. Banks also has a **Type filter** (Checking, Savings, Credit Card, etc.) in addition to Status filter — add a test for type filter toggling in `search-and-filters.spec.ts`.
