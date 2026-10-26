/** A continuously running certificate process must not hold financial authority. */
export function assertCertificateSigner(signer, { operator, owner, treasury }) {
  if ([signer, operator, owner, treasury].some(value => typeof value !== "string" || !value)) {
    throw new Error("Signer role configuration is incomplete.");
  }
  const address = signer.toLowerCase();
  if ([operator, owner, treasury].some(value => value.toLowerCase() === address)) {
    throw new Error("Certificate signer must be separate from operator, owner and treasury.");
  }
}
