---
trigger: always_on
description: Mandatory Code Quality Enforcement
---

# Code Quality Protocol

Every time you finish a task, modify a file, or before submitting your work, you MUST run the project's unified check suite.

## 🛠 Required Commands

1. **Validation**: Run `bun check` to execute the full suite:
   - **Linter**: `oxlint` (Blazing fast pattern/bug detection)
   - **Formatter**: `oxfmt` (Stylistic consistency)
   - **Typecheck**: `tsc --noEmit` (Structural integrity)

## 🔧 Auto-Remediation

If `bun check` fails, attempt to auto-fix before manually debugging:

- Use `bun fix` to auto-repair linting issues.
- Use `bun fmt` to auto-repair formatting issues.

## 🚫 Restricted Tools

- **NEVER** install or use ESLint, Prettier, or Biome. This project is standardized on the Oxc toolchain for performance.
- Avoid using `// @ts-ignore`. If a type error occurs, prefer proper type annotations or `: any` as a last resort for complex circular Drizzle references.

**The task is NOT complete until `bun check` passes with zero errors and zero warnings.**
