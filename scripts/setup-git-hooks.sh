#!/usr/bin/env bash

# Git Hooks Setup Script
# This script sets up husky and installs the git hooks

echo "🔧 Setting up Git hooks..."

# Check if husky is installed
if ! command -v husky &> /dev/null; then
    echo "❌ Husky not found. Installing..."
    bun add -D husky
else
    echo "✅ Husky already installed"
fi

# Install husky hooks
echo "📦 Installing husky hooks..."
bun run prepare

# Make hooks executable
echo "🔐 Making hooks executable..."
chmod +x .husky/pre-commit
chmod +x .husky/pre-push

# Verify hooks are set up
if [ -f ".husky/pre-commit" ] && [ -f ".husky/pre-push" ]; then
    echo "✅ Git hooks setup complete!"
    echo ""
    echo "📋 Available hooks:"
    echo "  • Pre-commit: lint, format check, typecheck, unit tests"
    echo "  • Pre-push: integration tests, component tests, coverage check"
    echo ""
    echo "🚀 You're ready to go! The hooks will run automatically on git operations."
else
    echo "❌ Hook setup failed. Please check the installation."
    exit 1
fi
