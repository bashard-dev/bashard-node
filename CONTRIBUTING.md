# Contributing to Bashard

Thank you for helping build verifiable storage tooling.

## Before starting

Read [the architecture](docs/ARCHITECTURE.md), [security policy](SECURITY.md)
and [code of conduct](CODE_OF_CONDUCT.md). Search existing issues before
opening a proposal. Discuss changes to economic parameters, signatures,
commitments, storage durability or public APIs before implementing them.

## Development workflow

1. Fork the repository and create a focused branch from main.
2. Install Node.js **24 LTS** and the package-manager version in package.json.
3. Run `pnpm install --frozen-lockfile`.
4. Make the smallest coherent change and add regression coverage.
5. Run the commands in the README and `git diff --check`.
6. Open a pull request describing the problem, implementation, verification,
   compatibility, security impact and any remaining limitations.

The profile repository contains documentation only and needs no package install.
For source repositories, keep the lockfile with dependency changes.

## Engineering expectations

- Preserve existing public behavior unless a breaking change was discussed.
- Use English for source documentation, interfaces and error messages.
- Express timestamps in UTC and distinguish epochs from wall-clock time.
- Use deterministic tests and isolated chain/storage doubles where possible.
- Never use a funded mainnet wallet in CI or ask contributors to share secrets.
- Do not fabricate operator counts, stored bytes, activity or recovery claims.
- Do not add vendor-specific deployment assumptions to portable protocol code.
- Keep UI changes keyboard-accessible and usable on mobile and desktop.
- Use concise, descriptive commit messages; do not backdate contribution history.

## Review and licensing

Small changes are easier to review. Include screenshots for visible changes
and exact commands/results for functional changes. Keep generated artifacts,
credentials and databases out of commits. Contributions are provided under
this repository's Apache-2.0 license; retain applicable notices and credit.

Questions: **support@bashard.com**.
