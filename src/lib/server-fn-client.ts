/**
 * The one place request-scoped code should call a TanStack Start server function from.
 *
 * Besides keeping the inferred argument/return types (the `as (opts: { data: unknown }) =>
 * Promise<X>` casts scattered around the routes throw those away), this asserts the transport
 * invariant that Start itself does not.
 */

export type ServerFnInput<TFn extends (...args: any[]) => Promise<any>> = Parameters<TFn>[0];

export type ServerFnResult<TFn extends (...args: any[]) => Promise<any>> = Awaited<ReturnType<TFn>>;

/** Best-effort identifier for an error message — present on the client proxy, absent during SSR. */
function serverFnName(fn: unknown): string {
  const meta = fn as { serverFnMeta?: { id?: string }; url?: string; name?: string };
  return meta?.url ?? meta?.serverFnMeta?.id ?? meta?.name ?? "(anonymous server function)";
}

export async function callServerFn<TFn extends (...args: any[]) => Promise<any>>(
  fn: TFn,
  opts: ServerFnInput<TFn>,
): Promise<ServerFnResult<TFn>> {
  const result = await fn(opts);

  // A server function that resolves to `undefined` never means "the handler returned nothing" —
  // no handler in src/routes/api/ returns void. It means the HTTP response was not a server-fn
  // envelope at all. Start's client only unwraps `{ result, error }` when the response carries
  // `x-tss-serialized`; any *other* JSON body (a Nitro/Cloud Run error page such as
  // `{"status":500,"unhandled":true,"message":"HTTPError"}`) is fed into the middleware chain as
  // a context patch, which leaves `result` and `error` both undefined — so the call *resolves*
  // instead of throwing. Combined with `const { data: accounts = [] } = useQuery(...)` at the
  // call sites, a transport failure would render as "this org has no accounts / no connections"
  // with no error anywhere. In accounting software a silent empty ledger is the worst possible
  // failure mode, so turn it back into a real rejection: React Query then retries it, and a
  // persistent failure surfaces as an error state instead of as missing data.
  if (result === undefined) {
    throw new Error(
      `Server function ${serverFnName(fn)} resolved to undefined. The /_serverFn response was ` +
        `not a TanStack-serialized envelope (missing the x-tss-serialized header) — usually a ` +
        `5xx whose body is JSON. Check the server log / network tab for the failing request.`,
    );
  }

  return result;
}
