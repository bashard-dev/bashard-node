# Production readiness

Mainnet coordination contracts have been deployed. The initial bootstrap
operator has a 1,000 BSHD self-stake and was selected in epoch 1. These are
on-chain setup facts, **not proof of continuous public storage availability**.

Before offering storage to customers, independently verify:

- The deployed token, Staking and Core addresses against chain ID 56.
- Owner, treasury, operator and hot-signer roles and key separation.
- Bytecode, contract parameters, allowances and actual received stake.
- An always-on operator host, TLS endpoint and valid durable-storage lease.
- Real upload, on-chain certification and byte-identical recovery from any
  seven valid shards.
- Data recovery after process restart and a real application republish.
- Monitoring, quota management, backups and an explicit keeper gas budget.
- Appropriate encryption and privacy handling for application data.
- Dependency advisories, contract review and incident procedures.

One bootstrap host is not a fault-tolerant independent network. A successful
private integration test does not establish public endpoint availability.
This software does not guarantee returns, data permanence or loss prevention.
Do not deploy a replacement BSHD token as part of bootstrap setup.
