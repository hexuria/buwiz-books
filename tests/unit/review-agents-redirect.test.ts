import { describe, expect, it } from "vitest";
import { isRedirect } from "@tanstack/react-router";
import { Route } from "../../src/routes/review-agents";

/**
 * `/review-agents` is retired but kept as a route so old bookmarks and links do not 404. Its only
 * job is to send the visitor to the Inbox before anything renders. (Authentication still runs
 * first: the root route's beforeLoad sends a signed-out visitor to /login.)
 */
describe("/review-agents", () => {
  function runBeforeLoad(): unknown {
    const beforeLoad = Route.options.beforeLoad as unknown as (ctx: unknown) => unknown;
    try {
      beforeLoad({});
    } catch (thrown) {
      return thrown;
    }
    return undefined;
  }

  it("redirects to the Inbox, replacing the history entry", () => {
    const thrown = runBeforeLoad();
    expect(isRedirect(thrown)).toBe(true);
    const { options } = thrown as { options: { to?: string; replace?: boolean } };
    expect(options.to).toBe("/inbox");
    expect(options.replace).toBe(true);
  });

  it("renders nothing of its own", () => {
    expect(Route.options.component).toBeUndefined();
    expect(Route.options.validateSearch).toBeUndefined();
  });
});
