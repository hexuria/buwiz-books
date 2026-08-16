# Test Files

This directory contains all test files organized by type:

## Directory Structure

```
tests/
├── unit/              # Unit tests for pure functions and utilities
├── integration/       # Integration tests for API endpoints and services
├── component/         # Component tests for React components
├── e2e/              # End-to-end tests for full user flows
├── fixtures/         # Mock data and test fixtures
├── utils/            # Test utilities and helpers
└── setup.ts          # Global test setup
```

## Test Types

### Unit Tests (`tests/unit/`)

- Test pure functions in isolation
- No external dependencies (DB, API, etc.)
- Fast execution
- Run with: `bun test:unit`

### Integration Tests (`tests/integration/`)

- Test API endpoints and server functions
- May include database interactions
- Test multiple modules working together
- Run with: `bun test:integration`

### Component Tests (`tests/component/`)

- Test React components with Testing Library
- Include user interactions and state changes
- Focus on component behavior, not implementation
- Run with: `bun test:component`

### E2E Tests (`tests/e2e/`)

- Test complete user flows with Playwright
- Run in real browser environment
- Test full application stack
- Run with: `bun test:e2e`

## Running Tests

```bash
# Run all tests (except E2E)
bun test

# Run specific test type
bun test:unit
bun test:integration
bun test:component
bun test:e2e

# Run tests in watch mode
bun test:watch

# Run tests with coverage
bun test:coverage

# Run tests with UI
bun test:ui
```

## Writing Tests

See the example test files in each directory for patterns and best practices.
