# Testing Guide

## 📋 Overview

This project uses a comprehensive testing strategy with four test types:

- **Unit Tests**: Pure function testing
- **Integration Tests**: API and service testing
- **Component Tests**: React component testing
- **E2E Tests**: Full user flow testing

## 🚀 Quick Start

```bash
# Run all tests (except E2E)
bun run test

# Run specific test type
bun run test:unit           # Unit tests only
bun run test:integration    # Integration tests only; requires TEST_DATABASE_URL
bun run test:component      # Component tests only
bun run test:e2e            # E2E tests with Playwright

# Development modes
bun run test:watch         # Watch mode for quick feedback
bun run test:ui            # Interactive UI for test debugging
bun run test:coverage      # Generate coverage report

# E2E specific
bun run test:e2e:ui        # E2E tests in UI mode
bun run test:e2e:debug     # E2E tests in debug mode
```

### Environment for database-backed tests

`test:e2e` runs `db:test:fresh` first, which drops the schema and then applies the whole
ordered migration manifest. Copy `.env.test.example` to `.env.test` before the first run —
three variables are required and the migration ones fail closed:

- `TEST_DATABASE_URL` — psql drops and recreates the schema with this.
- `MIGRATION_DATABASE_URL` — parsed before any client opens. The `localhost` alias is
  rejected, so use the `127.0.0.1` literal.
- `MIGRATION_SCHEMA_SYNC_CONFIRM` — must exactly equal that target's database name, or no
  schema tool runs at all.

```bash
# Run every currently safe project (E2E stays separate until reset isolation lands)
bun run test:all
```

## 📁 Test Structure

```
tests/
├── unit/              # Pure function tests (fast, isolated)
├── integration/       # API & service tests (database integration)
├── component/         # React component tests (UI behavior)
├── e2e/              # End-to-end tests (full user flows)
├── fixtures/         # Mock data and test fixtures
├── utils/            # Test helpers and utilities
├── global-setup.ts   # Runs ONCE before all files (roles, global catalogs)
└── setup.ts          # Global test configuration
```

`global-setup.ts` runs once per process, before any test file. It creates the
`buwiz_app` role that RLS integration tests switch to, and seeds global catalog
tables such as `review_rule_definitions`. Anything a test needs that is shared
across _every_ organization belongs there — if individual test files hand-insert
it instead, the suite can stay green over a database state that no real
environment ever has. That is precisely how an unseeded review-agent catalog went
unnoticed: the only rows in CI were the ones two tests inserted themselves.

## 🧪 Test Configuration

### Vitest (Unit/Integration/Component)

- **Config**: `vitest.config.ts`
- **Environment**: jsdom
- **Coverage**: v8 provider
- **Setup**: `tests/setup.ts`

### Playwright (E2E)

- **Config**: `playwright.config.ts`
- **Browsers**: Chromium, Firefox, WebKit
- **Base URL**: http://localhost:3000

## ✍️ Writing Tests

### Unit Test Example

```typescript
import { describe, it, expect } from "vitest";

describe("calculateTotal", () => {
  it("should sum numbers correctly", () => {
    expect(calculateTotal([1, 2, 3])).toBe(6);
  });
});
```

### Component Test Example

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

describe('MyComponent', () => {
  it('should handle clicks', async () => {
    const user = userEvent.setup();
    render(<MyComponent />);

    await user.click(screen.getByRole('button'));

    expect(screen.getByText('Clicked')).toBeInTheDocument();
  });
});
```

### Integration Test Example

```typescript
import { describe, it, expect } from "vitest";

describe("API /accounts", () => {
  it("should return accounts", async () => {
    const res = await fetch("/api/accounts");
    const data = await res.json();

    expect(Array.isArray(data)).toBe(true);
  });
});
```

### E2E Test Example

```typescript
import { test, expect } from "@playwright/test";

test("user can create account", async ({ page }) => {
  await page.goto("/accounts");
  await page.click('button:has-text("New")');
  await page.fill('input[name="name"]', "Test Account");
  await page.click('button[type="submit"]');

  await expect(page.locator("text=Test Account")).toBeVisible();
});
```

## 📊 Coverage

Generate coverage reports with:

```bash
bun test:coverage
```

Coverage reports are saved to `coverage/` directory.

## 🎯 Best Practices

1. **Test Behavior, Not Implementation**: Focus on what the code does, not how it does it
2. **Follow AAA Pattern**: Arrange, Act, Assert
3. **Keep Tests Independent**: Each test should run in isolation
4. **Use Descriptive Names**: Test names should describe the expected behavior
5. **Mock External Dependencies**: Use mocks for APIs, databases, etc.
6. **Test Edge Cases**: Don't just test the happy path

## 🔧 Troubleshooting

### Tests failing with module errors

- Ensure `vitest.config.ts` has proper path aliases
- Check that all dependencies are installed

### E2E tests timing out

- Increase timeout in `playwright.config.ts`
- Ensure dev server is running on port 3000

### Coverage not generating

- Install coverage provider: `bun add -D @vitest/coverage-v8`
- Check `vitest.config.ts` coverage configuration

### A whole file fails, but passes when run alone

Suspect shared global state before suspecting the test. Integration tests run
with `--no-file-parallelism` against **one** database, and a handful of tables —
`review_rule_definitions` among them — have no `organization_id` at all, so a
write to one is visible to every file that runs after it.

The usual cause is a test that mutates such a row and restores it afterwards,
where the restore sits after the assertions rather than in a `finally`. A single
failed expectation then leaks the mutated value into the rest of the run, and the
failure surfaces in some unrelated file downstream.

Prefer not to mutate globally-shared rows at all — pick one nothing reads. If you
must, restore in a `finally`.

## 📚 Resources

- [Vitest Documentation](https://vitest.dev)
- [Testing Library](https://testing-library.com)
- [Playwright Documentation](https://playwright.dev)
