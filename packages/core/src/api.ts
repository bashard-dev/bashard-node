// Shapes returned by the indexer API (apps/indexer) and consumed by the app
// and scan frontends. Token amounts and big numbers travel as decimal strings.

export type EpochPhase = "Sync" | "Active" | "Closing";

export interface NetworkStats {
  chainId: number;
  epoch: number;
  phase: EpochPhase;
  epochStartedAt: number;
  epochDuration: number;
  committeeSize: number;
  nodes: number;
  activeNodes: number;
  totalStake: string;
  bytesStored: number;
  tracks: number;
  tracksCertified24h: number;
  tapes: number;
  challengesPassed: number;
  challengesFailed: number;
  indexedBlock: number;
  headBlock: number;
  pricePerMBEpoch: string;
}

export interface NodeInfo {
  address: string;
  signer: string;
  name: string;
  endpoint: string;
  commissionBps: number;
  active: boolean;
  jailedUntil: number;
  stake: string;
  operatorRewards: string;
  registeredEpoch: number;
  inCommittee: boolean;
  shardsHeld: number;
  challengesPassed: number;
  challengesFailed: number;
  slashes: number;
  lastSeen: number | null;
}

export interface CommitteeMember {
  node: string;
  name: string;
  stake: string;
}

export interface EpochInfo {
  epoch: number;
  startedAt: number;
  seed: string;
  committee: CommitteeMember[];
  rewardsPaid: string | null;
  tracksRegistered: number;
}

export interface TapeInfo {
  id: number;
  owner: string;
  capacityMB: number;
  usedBytes: number;
  startEpoch: number;
  expiryEpoch: number;
  trackCount: number;
  createdAt: number;
  tx: string;
}

export type TrackState = "registered" | "certified" | "deleted";

export interface TrackInfo {
  id: number;
  tapeId: number;
  owner: string;
  key: string;
  contentType: string;
  size: number;
  root: string;
  epoch: number;
  status: TrackState;
  signers: number;
  registeredAt: number;
  certifiedAt: number | null;
  registerTx: string;
  certifyTx: string | null;
}

export type EventKind =
  | "EpochAdvanced"
  | "RewardsPaid"
  | "TapeReserved"
  | "TapeExtended"
  | "TapeExpanded"
  | "TapeTransferred"
  | "TrackRegistered"
  | "TrackCertified"
  | "TrackDeleted"
  | "NodeSlashed"
  | "NodeRegistered"
  | "NodeUpdated"
  | "NodeActiveChanged"
  | "Delegated"
  | "UnstakeRequested"
  | "Withdrawn"
  | "RewardDistributed"
  | "CommissionClaimed"
  | "Challenge";

export interface ActivityEvent {
  id: string;
  kind: EventKind;
  block: number;
  tx: string;
  time: number;
  /** Address that the event concerns (owner, delegator, node). */
  actor: string | null;
  summary: string;
  data: Record<string, unknown>;
}

export interface DelegationInfo {
  node: string;
  nodeName: string;
  shares: string;
  value: string;
  principal: string;
}

export interface UnbondingInfo {
  amount: string;
  releaseEpoch: number;
}

export interface AccountInfo {
  address: string;
  tapes: TapeInfo[];
  delegations: DelegationInfo[];
  unbondings: UnbondingInfo[];
  storageUsed: number;
  storageCapacityMB: number;
  objects: number;
}

export interface SearchResult {
  type: "track" | "tape" | "node" | "account" | "tx" | "epoch";
  id: string;
  label: string;
}

/** Signed challenge outcome that nodes report to the indexer. */
export interface ChallengeReport {
  epoch: number;
  challenger: string; // operator address
  target: string;     // operator address
  trackId: string;
  shardIndex: number;
  passed: boolean;
  latencyMs: number;
  time: number;
  signature: string;  // challenger's signer key over the JSON body without `signature`
}
