import test from "node:test";
import assert from "node:assert/strict";
import { assertCertificateSigner } from "./signer-policy.mjs";

const roles = {
  operator: `0x${"11".repeat(20)}`,
  owner: `0x${"ab".repeat(20)}`,
  treasury: `0x${"33".repeat(20)}`,
};
test("a separate certificate-only public address is accepted", () => {
  assert.doesNotThrow(() => assertCertificateSigner(`0x${"44".repeat(20)}`, roles));
});
test("each financial authority is rejected as the certificate signer", () => {
  for (const address of Object.values(roles)) {
    assert.throws(() => assertCertificateSigner(address, roles), /must be separate/);
  }
});
test("owner protection cannot be bypassed with a different address case", () => {
  assert.throws(() => assertCertificateSigner(roles.owner.toUpperCase(), roles), /must be separate/);
});
test("missing role information fails closed", () => {
  assert.throws(() => assertCertificateSigner(`0x${"44".repeat(20)}`, { ...roles, owner: undefined }), /incomplete/);
});
