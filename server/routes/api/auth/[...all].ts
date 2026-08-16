/**
 * Better Auth API Route Handler
 *
 * Nitro catch-all route for Better Auth endpoints.
 * Handles all /api/auth/* requests:
 * - /api/auth/sign-in/social
 * - /api/auth/callback/google
 * - /api/auth/sign-out
 * - /api/auth/get-session
 */

import { auth } from "../../../../src/lib/auth";
import { defineEventHandler, getRequestURL, getMethod, getHeaders, readRawBody } from "h3";

export default defineEventHandler(async (event) => {
  // Manually construct Web Request from H3 event
  const url = getRequestURL(event);
  const method = getMethod(event);
  const headers = getHeaders(event);

  // For requests with body, read it
  const body = method !== "GET" && method !== "HEAD" ? await readRawBody(event) : undefined;

  const request = new Request(url.toString(), {
    method,
    headers: new Headers(headers as HeadersInit),
    body: body || undefined,
  });

  return auth.handler(request);
});
