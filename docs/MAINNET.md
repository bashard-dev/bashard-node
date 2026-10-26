# BSC mainnet deployment

Network: BNB Smart Chain (chain ID **56**).

| Contract | Address |
| --- | --- |
| BSHD token | `0x86d2371d508c3f39cd4dce58d0ee406250d57777` |
| Staking | `0x23E21D9b8Ecc71fF0452A1fb19ca92fBF0834762` |
| Bashard Core | `0xA1a63761DDfA41974DFBC0C2600bc25b2D872343` |

These are public on-chain addresses, not credentials. Verify deployed state
independently before authorizing any transaction. The existing token is
authoritative; deployment scripts must not create a replacement token.

Live minimum self-stake at bootstrap: **1,000 BSHD**. Live storage price at
bootstrap: **0.0001 BSHD per MB per epoch**. Epoch duration: **86,400 seconds**.
Read current values from the contracts: governance may change parameters.
Unbonding has a two-epoch waiting period and remains subject to contract rules.

The deployment manifest and ABI source are public. Public metadata and
transaction hashes do not reveal a private key, but do not place private RPC
credentials, wallet exports or infrastructure identifiers in configuration.
