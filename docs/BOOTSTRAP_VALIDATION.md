# Bootstrap integration validation

Verified at **2026-10-26T12:19:46.433Z** on BNB Smart Chain,
chain ID **56**. These results describe a controlled integration run, not a
public-service uptime commitment.

## Results

- One bootstrap operator registered with **1,000 BSHD** self-stake.
- Committee epoch **1**, with **one** member.
- Test tape **1**: 1 MB for 3 epochs, costing **0.0003 BSHD**.
- Track **1**: a generated **65,536-byte** integration file.
- Twenty shards durably acknowledged in private cloud storage.
- Storage certificate verified and committed on-chain.
- Reconstruction from seven non-contiguous shards matched the original bytes.
- The custody process was stopped, restarted, and reconstructed the same bytes.
- SHA-256: `1d0f5e51260e18ef717b2024209043afa95380822e07bfbe047005004bdb8543`.

## Confirmed transactions

| Operation | Transaction | Block |
| --- | --- | --- |
| approve-staking-1000 | [0xcd64103c90…](https://bscscan.com/tx/0xcd64103c909f1dc60553ac220b1b8159845ac0dcf6da71987cb8c432d448c4b9) | 129895114 |
| register-bootstrap-1000 | [0x3026664c09…](https://bscscan.com/tx/0x3026664c09f4fb021af86ae8db0863727a2d3119356798f8c48995d6f03017f2) | 129895178 |
| advance-bootstrap-epoch | [0x07e3de6b7d…](https://bscscan.com/tx/0x07e3de6b7d18acd326b25f7a2ed913ef1e38ae041639c4ca704605c097d8bf6c) | 129895187 |
| approve-core-test-rent | [0xe1bf94771c…](https://bscscan.com/tx/0xe1bf94771c37f153db5decc2367b96eb18876596839867d71dffded821b6b33d) | 129895196 |
| reserve-test-tape-1mb-3epochs | [0xeef72578ea…](https://bscscan.com/tx/0xeef72578eaf0dfb7eb0f5ada49e25146b34c3ac7d4ad1c564fdc159e70954cd2) | 129895204 |
| register-test-track | [0x47482ff49c…](https://bscscan.com/tx/0x47482ff49c909976f693440bab9c0c82263db5dd54cfa4b882c7cbbfab1140a8) | 129896261 |
| certify-test-track | [0xfecce3a002…](https://bscscan.com/tx/0xfecce3a002d3c7a89052ef750999a53c455bfa21166920d13fc9c3c4f3c81ba9) | 129896332 |

## Not established by this run

Public endpoint availability after publication, recovery after an actual
application republish, continuous uptime, independent-host redundancy,
third-party contract audit and automatic keeper operations remain separate
validation gates. No real customer files were used. The certificate-only
custody process did not receive an owner, treasury or deployment private key.
