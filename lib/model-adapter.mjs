/**
 * Extension contract for a future real model. Nothing here executes transactions.
 * Configure credentials on the server, never in the browser or source control.
 * Any returned proposal must pass schema validation, semantic validation,
 * deterministic risk checks and the existing user authorization gateway.
 * This adapter is intentionally NOT enabled in the offline demo.
 */
export class ModelInterpreter {
  async propose({ transcript, authorizedPayees, sourceAccounts }) {
    void transcript; void authorizedPayees; void sourceAccounts;
    throw new Error('Implement a server-side model proposal adapter; do not grant it ledger access.');
  }
}
