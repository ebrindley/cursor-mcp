import type { CursorClient } from "./client.js";
import { seg } from "./client.js";
import { log } from "./log.js";
import { IdResponseSchema } from "./schemas.js";
import { independently, withWaitScope } from "./request-context.js";
import { createWaitScope, within } from "./wait.js";

export type RejectedRunCleanup = "cancellation-requested" | "cancellation-failed";

/**
 * Best-effort containment after Cursor created a run that failed local target
 * validation. Archiving is not cancellation, so this uses the exact run route.
 */
export async function cancelRejectedRun(
  client: CursorClient,
  agentId: string,
  runId: string,
): Promise<RejectedRunCleanup> {
  const scope = createWaitScope({ timeoutMs: 5_000 });
  try {
    await independently(() => withWaitScope(scope, () => within(scope, () => client.post(
      `/v1/agents/${seg(agentId)}/runs/${seg(runId)}/cancel`,
      IdResponseSchema,
    ))));
    return "cancellation-requested";
  } catch (error) {
    log.debug(
      `could not request cancellation for rejected run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "cancellation-failed";
  } finally { scope.dispose(); }
}

export function rejectedRunCleanupMessage(cleanup: RejectedRunCleanup): string {
  return cleanup === "cancellation-requested"
    ? "cancellation was requested for the created run"
    : "cancellation of the created run could not be confirmed; cancel it explicitly";
}
