/** Convert a finalized assistant message into a user-facing terminal error. */
export function getErrorMessage(message: unknown): string | undefined {
  const value = message as { errorMessage?: string; stopReason?: string };
  if (value?.errorMessage) return value.errorMessage;
  if (value?.stopReason === "error") return "The model returned an error. Check the gateway console for details.";
  return undefined;
}

/**
 * Holds an attempt's model error until agent_end says whether that attempt is
 * terminal. Retryable failures are discarded instead of being rendered into
 * the eventual successful response.
 */
export class SessionErrorBuffer {
  private pending: string | undefined;

  beginAttempt() {
    this.pending = undefined;
  }

  capture(message: unknown) {
    const value = message as { role?: string };
    if (value?.role === "assistant") this.pending = getErrorMessage(message);
  }

  finishAttempt(willRetry: boolean): string | undefined {
    const error = this.pending;
    this.pending = undefined;
    return willRetry ? undefined : error;
  }
}
