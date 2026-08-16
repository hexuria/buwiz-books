/**
 * Pluggable error reporting. The logger forwards every `error`-level log here so a real
 * error-tracking backend (Sentry, Datadog, an internal webhook…) can be wired in ONE place
 * without coupling the rest of the app to a vendor SDK.
 *
 * By default this is a no-op. To enable reporting, call registerErrorReporter() once at
 * server startup (e.g. in the Nitro entry) with an implementation, or point ERROR_WEBHOOK_URL
 * at an endpoint to use the built-in webhook reporter.
 */
export interface ErrorReport {
  scope: string;
  message: string;
  meta?: Record<string, unknown>;
  timestamp: string;
}

type ErrorReporter = (report: ErrorReport) => void;

let reporter: ErrorReporter | null = null;

export function registerErrorReporter(fn: ErrorReporter): void {
  reporter = fn;
}

/**
 * Built-in fire-and-forget webhook reporter. Enabled automatically when ERROR_WEBHOOK_URL
 * is set and no custom reporter has been registered. Failures are swallowed so reporting
 * can never take down a request.
 */
function defaultWebhookReporter(report: ErrorReport): void {
  const url = process.env.ERROR_WEBHOOK_URL;
  if (!url) return;
  // Never await — reporting must not block or throw into the caller.
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
  }).catch(() => {});
}

export function reportError(report: ErrorReport): void {
  try {
    if (reporter) {
      reporter(report);
    } else {
      defaultWebhookReporter(report);
    }
  } catch {
    // Reporting must never throw into the logging path.
  }
}
