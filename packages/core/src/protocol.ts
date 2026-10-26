// Off-chain mirrors of on-chain rules: shard placement and signed messages.

import { encodeAbiParameters, hexToBigInt, keccak256, toBytes, type Address, type Hex } from "viem";
import { SHARDS_N } from "./erasure";

export const CERTIFY_TAG = keccak256(toBytes("BASHARD_CERTIFY_V1"));
export const SLASH_TAG = keccak256(toBytes("BASHARD_SLASH_V1"));

export enum SlashReason {
  FailedChallenges = 1,
  Unreachable = 2,
}

export enum TrackStatus {
  None = 0,
  Registered = 1,
  Certified = 2,
  Deleted = 3,
}

/** Same digest as Bashard.certifyDigest(trackId, root). Sign it with signMessage({ raw }). */
export function certifyDigest(chainId: number, contract: Address, trackId: bigint, root: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
      [CERTIFY_TAG, BigInt(chainId), contract, trackId, root],
    ),
  );
}

/** Same digest as Bashard.slashDigest(node, epoch, reason). */
export function slashDigest(chainId: number, contract: Address, node: Address, epoch: number, reason: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint32" }, { type: "uint8" }],
      [SLASH_TAG, BigInt(chainId), contract, node, epoch, reason],
    ),
  );
}

export function quorum(members: number): number {
  return members === 0 ? Infinity : Math.floor((2 * members + 2) / 3);
}

/**
 * Committee member index that holds shard `shardIndex` of `trackId`.
 * Shards rotate around the committee from a per-track offset, so with a full
 * committee of 20 every shard sits on a different node.
 */
export function holderIndex(trackId: bigint, shardIndex: number, committeeSize: number): number {
  if (committeeSize === 0) throw new Error("empty committee");
  const offset = hexToBigInt(keccak256(encodeAbiParameters([{ type: "uint256" }], [trackId])));
  return Number((offset + BigInt(shardIndex)) % BigInt(committeeSize));
}

/** Shard indexes a given committee member is responsible for. */
export function shardsForMember(trackId: bigint, memberIndex: number, committeeSize: number, n = SHARDS_N): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (holderIndex(trackId, i, committeeSize) === memberIndex) out.push(i);
  return out;
}

/** Placement of all N shards on a committee. */
export function placement(trackId: bigint, committee: readonly Address[], n = SHARDS_N): Address[] {
  return Array.from({ length: n }, (_, i) => committee[holderIndex(trackId, i, committee.length)]);
}
