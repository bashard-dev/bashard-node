import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bashardAbi, stakingAbi } from "@bashard/core";
const MAINNET_DEPLOYMENT = fileURLToPath(new URL("../../packages/contracts/deployments/bsc.json", import.meta.url));
import { ethers } from "ethers";
import { cloudLocation, CloudShardRepository, CloudLease } from "./cloud-repository.mjs";
import { createCustodyServer } from "./protocol.mjs";
import { assertCertificateSigner } from "./signer-policy.mjs";

const log = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));
let provider, lease, server, renewal, cleanup, stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(renewal); clearInterval(cleanup);
  if (server) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  await lease?.release();
  provider?.destroy();
}
async function main() {
  if (process.env.NODE_ENV !== "production") throw new Error("Custody is production-only.");

  const operator = ethers.getAddress(process.env.OPERATOR_ADDRESS?.toLowerCase() || "");
  // Only an off-chain certificate key is present. No gas-spending/operator key
  // or deployment authority is accepted by the custody process.
  if (!process.env.SIGNER_KEY) throw new Error("Certificate signer Secret is required.");
  const wallet = new ethers.Wallet(process.env.SIGNER_KEY);
  const deployment = JSON.parse(readFileSync(MAINNET_DEPLOYMENT, "utf8"));
  assertCertificateSigner(wallet.address, { operator, owner: deployment.owner, treasury: deployment.treasury });
  provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || process.env.RPC_URL);
  if (Number((await provider.getNetwork()).chainId) !== 56) throw new Error("BSC mainnet required.");

  const core = new ethers.Contract(deployment.bashard, bashardAbi, provider);
  const staking = new ethers.Contract(deployment.staking, stakingAbi, provider);
  const chain = {
    node: who => staking.getNode(who),
    track: id => core.getTrack(id),
    tape: id => core.getTape(id),
    epoch: () => core.epochInfo(),
    committee: async epoch => (await core.committee(epoch)).members,
  };
  const location = cloudLocation();
  const prefix = `${location.base}/56/${deployment.bashard.toLowerCase()}/${operator.toLowerCase()}`;
  const limit = Number(process.env.OPERATOR_MAX_STORAGE_GB || "20");
  if (!Number.isFinite(limit) || limit <= 0 || limit > 1000) throw new Error("Invalid storage quota.");
  const repository = new CloudShardRepository(location.bucket, prefix, Math.floor(limit * 1024 ** 3));
  lease = new CloudLease(location.bucket, prefix);
  await lease.acquire();
  await repository.usage(true);
  renewal = setInterval(() => lease.renew().catch(() => log("custody_lease_unavailable")), 20000);
  let pruning = false;
  cleanup = setInterval(async () => {
    if (!lease.valid() || pruning) return;
    pruning = true;
    try {
      // Irreversible deletion follows finalized chain state, never wall-clock
      // guesses or unfinalized events. No transaction is submitted.
      const block = await provider.getBlock("finalized");
      if (!block) throw new Error();
      const overrides = { blockTag: block.number };
      const epoch = await core.currentEpoch(overrides);
      const records = await repository.records();
      for (const record of records) {
        if (!lease.valid()) break;
        const track = await core.getTrack(record.track, overrides);
        const tape = await core.getTape(track.tapeId, overrides);
        if (Number(track.status) === 3 || (Number(track.status) !== 0 && Number(tape.expiryEpoch) <= Number(epoch))) {
          await repository.remove(record);
        }
      }
    } catch { log("custody_cleanup_deferred"); }
    finally { pruning = false; }
  }, 60000);
  server = createCustodyServer({
    chain, repository, lease, operator, core: deployment.bashard, log,
    signer: { address: wallet.address, signDigest: digest => wallet.signMessage(ethers.getBytes(digest)) },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(process.env.PORT || "7001"), "127.0.0.1", resolve);
  });
  log("custody_listener_started", { chainId: 56, durableStorage: "app_storage", unattendedTransactions: false });
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
main().catch(async () => {
  log("custody_start_failed", { message: "Check operator configuration, signer Secret, App Storage and RPC." });
  await stop(); process.exitCode = 1;
});
