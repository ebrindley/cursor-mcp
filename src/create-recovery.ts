import { USAGE_LIMITED_CLASS } from "./api-errors.js";
import { CursorCancelledError } from "./client.js";
import { CursorApiError, CursorContractError, CursorTransportError } from "./errors.js";

export async function withCreateRecovery<T>(agentId: string, create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (error) {
    // Keep recovery identity ahead of upstream detail so response fitting retains it.
    const recovery = `Requested agentId ${agentId}. Inspect cursor_get_agent with this ID before retrying. `;
    if (error instanceof CursorCancelledError) {
      throw new CursorCancelledError(recovery + error.message);
    }
    if (error instanceof CursorTransportError) {
      // The client distinguishes pre-dispatch failure from an uncertain write.
      throw new CursorTransportError(recovery + error.message);
    }
    if (error instanceof CursorContractError) {
      throw new CursorContractError(recovery + "The launch outcome is unknown. " + error.message);
    }
    if (error instanceof CursorApiError && error.classification !== USAGE_LIMITED_CLASS) {
      const conflict = error.status === 409 && error.code === "agent_id_conflict";
      // Creates have returned 404 for agents later found by readback.
      if (conflict || error.status === 404 || error.status >= 500) {
        const outcome = conflict ? "The agent ID already exists. " : "The launch outcome is unknown. ";
        throw new CursorApiError(error.status, recovery + outcome + error.message,
          error.code, error.retryAfterMs, error.classification);
      }
    }
    throw error;
  }
}
