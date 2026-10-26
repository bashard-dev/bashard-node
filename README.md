# Bashard Node

Bashard storage operators, cloud-backed custody, a read-only chain indexer and verifiable shard-serving infrastructure.

[Website](https://bashard.com) · [App](https://app.bashard.com) ·
[Scan](https://scan.bashard.com) · [Docs](https://bashard.com/docs) ·
[Developer profile](https://github.com/bashard-dev)

**Status:** pre-release bootstrap software. Read
[production readiness](docs/PRODUCTION_READINESS.md) before using real funds
or customer data. Deployment is not an audit or an availability guarantee.

## Requirements

Node.js **24 LTS**, pnpm **10.28.0**, and a BSC RPC endpoint for operations that
read chain state. Secrets are not required to compile source or run pure tests.

## Services

| Path | Responsibility |
| --- | --- |
| apps/custody | Certificate-only custody server backed by private cloud objects |
| apps/node | Original disk-backed operator, repair and optional keeper tools |
| apps/indexer | Read-only chain-event indexer and REST/SSE API |
| packages/core, packages/sdk | Shared protocol and client source snapshots |

## Quick start

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
# Configure the variables in .env.example in your service environment.
pnpm run start:cloud
```

Cloud custody uses standard Google Cloud Application Default Credentials.
Use workload identity or a trusted secret manager; never commit a credential
file. The bucket must be private and the service needs access only to its
custody prefix. Persisting a signed certificate is not a substitute for
persisting the corresponding shard bytes.

The cloud service receives a separate certificate key and **does not send
gas-spending transactions**. Keep owner, treasury and deployment credentials
out of its process. It rejects unregistered operators and invalid commitments.

### Other explicit commands

- `pnpm run start:indexer`: start the read-only event indexer.
- `pnpm run start:disk`: start the original disk node. Review its operational
  configuration first: audit/keeper functionality may submit transactions
  when an operator key is supplied. Keeper execution defaults off in this
  distribution and requires deliberate configuration.

Use an always-on host and a durable disk or private cloud storage. A transient
filesystem is not sufficient for customer data.

## Node HTTP API

The custody service implements health, pre-registration bootstrap inspection,
shard PUT/GET, roots, certification and proof-of-access routes under /v1.
Only a valid paid on-chain track and matching committee assignment can admit
shards. There is no arbitrary unauthenticated bucket-upload endpoint.


## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Mainnet deployment and roles](docs/MAINNET.md)
- [Production readiness](docs/PRODUCTION_READINESS.md)
- [Roadmap](ROADMAP.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)

## Related repositories

[Protocol and SDK](https://github.com/bashard-dev/bashard-protocol) ·
[Node and indexer](https://github.com/bashard-dev/bashard-node) ·
[Web applications](https://github.com/bashard-dev/bashard-web)

## Contact and license

Developer contact: **support@bashard.com** · X: https://x.com/Bashard_

Licensed under [Apache-2.0](LICENSE). Retain applicable source and third-party
notices. No warranty, custody guarantee or financial return is implied.

## Verifiable bootstrap activity

See the [integration validation report](docs/BOOTSTRAP_VALIDATION.md) for
public transaction receipts, file-integrity evidence and explicit limitations.
