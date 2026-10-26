# Architecture

## Data plane

An uploader encodes each file into **20 Reed–Solomon shards**. Any **7 valid
shards** reconstruct the original bytes. Shard roots commit to 1 KiB Merkle
leaves; a track root commits to all shard roots. Nodes validate commitments
before acknowledging writes and sign certificates only for shards they hold.
File bytes are not published to the blockchain.

## Coordination plane

BNB Smart Chain, chain ID **56**, records stake, epochs, committee membership,
storage tapes, track commitments and certificates. A tape purchases capacity
for a number of epochs. Its quote is capacity × epochs × the deployed price.
The SDK keeps encoding, commitment and transport logic separate from wallet
transactions. The indexer derives read models from contract events.

## Boundaries

Public clients never need a deployment key. Storage certificate keys must be
separate from operator, contract-owner and treasury keys. Node registration
and gas spending require explicit operator authorization. A process reporting
HTTP 200 is not sufficient proof of custody: verify identity, durable storage,
committee membership, certificates and reconstructed bytes.

## Bootstrap limitations

One operator may hold all assigned shards. This is **not independent-host
redundancy**, even though the encoding has twenty pieces. Encoding is also
**not encryption**. Applications requiring confidentiality must encrypt data
before upload and manage encryption keys separately.

## Source ownership

The canonical shared protocol packages live in
[bashard-protocol](https://github.com/bashard-dev/bashard-protocol). The node and web repositories
include source snapshots of their shared packages so a public checkout can
build without access to private registries. Changes to shared protocol
semantics should be proposed upstream and synchronized deliberately.
