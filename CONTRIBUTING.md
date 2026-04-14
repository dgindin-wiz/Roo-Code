<div align="center">
<sub>

<b>English</b> • [Català](locales/ca/CONTRIBUTING.md) • [Deutsch](locales/de/CONTRIBUTING.md) • [Español](locales/es/CONTRIBUTING.md) • [Français](locales/fr/CONTRIBUTING.md) • [हिंदी](locales/hi/CONTRIBUTING.md) • [Bahasa Indonesia](locales/id/CONTRIBUTING.md) • [Italiano](locales/it/CONTRIBUTING.md) • [日本語](locales/ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](locales/ko/CONTRIBUTING.md) • [Nederlands](locales/nl/CONTRIBUTING.md) • [Polski](locales/pl/CONTRIBUTING.md) • [Português (BR)](locales/pt-BR/CONTRIBUTING.md) • [Русский](locales/ru/CONTRIBUTING.md) • [Türkçe](locales/tr/CONTRIBUTING.md) • [Tiếng Việt](locales/vi/CONTRIBUTING.md) • [简体中文](locales/zh-CN/CONTRIBUTING.md) • [繁體中文](locales/zh-TW/CONTRIBUTING.md)

</sub>
</div>

# Contributing to Roo Code

Roo Code is a community-driven project, and we deeply value every contribution. To streamline collaboration, we operate on an issue-first workflow, and meaningful pull requests should stay anchored to a GitHub issue from planning through validation.

## Table of Contents

- [Before You Contribute](#before-you-contribute)
- [Finding & Planning Your Contribution](#finding--planning-your-contribution)
- [GitHub Workflow](#github-workflow)
- [Development & Submission Process](#development--submission-process)
- [Legal](#legal)

## Before You Contribute

### 1. Code of Conduct

All contributors must adhere to our [Code of Conduct](./CODE_OF_CONDUCT.md).

### 2. Project Roadmap

Our roadmap guides the project's direction. Align your contributions with these key goals:

### Reliability First

- Ensure diff editing and command execution are consistently reliable.
- Reduce friction points that deter regular usage.
- Guarantee smooth operation across all locales and platforms.
- Expand robust support for a wide variety of AI providers and models.

### Enhanced User Experience

- Streamline the UI/UX for clarity and intuitiveness.
- Continuously improve the workflow to meet the high expectations developers have for daily-use tools.

### Leading on Agent Performance

- Establish comprehensive evaluation benchmarks (evals) to measure real-world productivity.
- Make it easy for everyone to easily run and interpret these evals.
- Ship improvements that demonstrate clear increases in eval scores.

Mention alignment with these areas in your PRs.

### 3. Project-specific collaboration

The generic workflow below applies across repositories. Roo Code also has project-specific collaboration channels:

- Join our [Discord](https://discord.gg/roocode) for community discussion.
- Follow any repository-specific maintainer guidance in issue threads or project boards.

### 4. Project-specific resources

These Roo Code resources are useful when choosing or shaping work in this repository:

- Check the [GitHub Project](https://github.com/orgs/RooCodeInc/projects/1) for "Issue [Unassigned]" issues.
- For docs-focused contributions, visit [Roo Code Docs](https://github.com/RooCodeInc/Roo-Code-Docs).

## Finding & Planning Your Contribution

### Types of Contributions

- **Bug Fixes:** Addressing code issues.
- **New Features:** Adding functionality.
- **Documentation:** Improving guides and clarity.

### Issue-First Approach

All meaningful contributions start with a GitHub issue.

- **Check existing issues** in this repository before opening a new one.
- **Create an issue** using:
    - **Enhancements:** the enhancement request template
    - **Bugs:** the bug report template
    - **Investigations:** the investigation template when diagnosis is the work
- **PRs must link to the issue.** Unlinked PRs may be closed or redirected.

### Deciding What to Work On

- Start from issues that already have clear scope, impact, and acceptance criteria.
- Prefer one coherent contribution at a time rather than mixing unrelated changes.
- Use any project-specific resources linked above to find areas that need attention in this repository.

### Reporting Bugs

- Check for existing reports first.
- Create a new bug using the bug report template with:
    - Clear, numbered reproduction steps
    - Expected vs actual result
    - Roo Code version (required); API provider/model if relevant
- **Security issues**: Report privately via GitHub security advisories.

## GitHub Workflow

### Intake issues versus operational work items

Public issue forms are intake-first. When an issue becomes active engineering work, maintainers may either:

- convert the same issue into the operational work item, or
- create a linked follow-on investigation or implementation issue

The active issue body should become the canonical current state for the work.

### Draft PR timing

Open a Draft PR once:

- the issue is anchored
- the diagnosis or plan is stable enough to implement
- the implementation container is selected
- there is a first coherent implementation slice or meaningful commit

Do not wait for every build, install, or validation step before opening the Draft PR.
Validation is the gate for moving a PR to ready for review, not the gate for opening the Draft PR.

### Bundle PRs and final PRs

If work is happening on a long-lived feature or release branch, treat that branch as the integration branch:

- bundle branches and interim PRs should target the integration branch
- the final PR from the integration branch to `main` is a separate artifact
- use `Closes #...` only when the merge target will actually resolve the issue
- use `Part of #...` for bundle PRs into an integration branch
- use `Related to #...` for adjacent or supporting work

### Canonical repo for GitHub writes

If your checkout has both a fork and an upstream remote:

- treat the checkout's `origin` as the default write target
- treat `upstream` as reference-only unless you explicitly intend to contribute there
- use explicit repository targeting when creating issues, PRs, or comments through GitHub tooling

### Templates and workflow artifacts

- Use the issue forms in `.github/ISSUE_TEMPLATE/`.
- Use the PR body template in `.github/PULL_REQUEST_TEMPLATE.md`.
- Keep validation results in the PR body or linked issue so review readiness is explicit.

## Development & Submission Process

### Development Setup

1. **Fork & Clone:**

```
git clone https://github.com/YOUR_USERNAME/Roo-Code.git
```

2. **Install Dependencies:**

```
pnpm install
```

3. **Debugging:** Open with VS Code (`F5`).

### Writing Code Guidelines

- One focused PR per feature or fix.
- Follow ESLint and TypeScript best practices.
- Write clear, descriptive commits referencing issues appropriately for the merge target.
- Provide thorough testing (`npm test`).
- Rebase onto the latest `main` branch before submission.

### Submitting a Pull Request

- Begin as a **Draft PR** if seeking early feedback.
- Clearly describe your changes following the Pull Request Template.
- Link the issue in the PR description using the correct link type for the merge target.
- If you are working from a long-lived feature or release branch, use bundle PRs into that branch and keep the final PR to `main` separate.
- Provide screenshots/videos for UI changes.
- Indicate if documentation updates are necessary.

### Pull Request Policy

- Must reference a GitHub Issue or linked operational work item.
- Unlinked PRs may be closed.
- PRs should pass CI tests, align with the roadmap, and have clear documentation.
- Work should not be treated as ready for review until validation is summarized explicitly.

### Review Process

- **Daily Triage:** Quick checks by maintainers.
- **Weekly In-depth Review:** Comprehensive assessment.
- **Iterate promptly** based on feedback.

## Legal

By contributing, you agree your contributions will be licensed under the Apache 2.0 License, consistent with Roo Code's licensing.
