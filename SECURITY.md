# Security policy

## Reporting

Use this repository's private vulnerability reporting facility when available,
or email **support@bashard.com** with a concise description, affected version,
impact and a minimal reproduction. Never send private keys, seed phrases,
access tokens, customer files or credential-bearing RPC URLs.

Do not publish an exploitable vulnerability in a public issue before
coordinated review. Response times and fixes are not guaranteed.

## Supported scope

The main branch is pre-release development software. Contract deployment is
not a claim of independent audit, formal verification, source verification,
production storage availability or financial safety. Review
[production readiness](docs/PRODUCTION_READINESS.md) before committing funds
or accepting customer data.

## Operational rules

- Keep credentials in a secret manager or untracked environment configuration.
- Use a separate certificate-only wallet, never an owner or treasury wallet.
- Grant exact token allowances; do not default to unlimited approval.
- Bound gas spending, persist transaction hashes before broadcast and reconcile
  receipts before retrying an interrupted operation.
- Do not enable automatic keeper or slash transactions without a spending policy.
- Reject missing or corrupted shards and invalid proofs. Never acknowledge
  data before durable storage succeeds.
- Use TLS, monitor storage quota and RPC health, and test restart recovery.
- Audit runtime and build-tool dependencies separately. A successful build is
  not a security audit. Do not commit credentials to fix a CI failure.

## Supply chain

Use the committed lockfile, inspect dependency changes and verify package
provenance. CI has read-only repository permissions and must not hold funded
wallets or deployment keys. Report remaining advisories honestly.
