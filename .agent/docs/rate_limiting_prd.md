# PRD: Production-Ready Rate Limiting Architecture

## 1. Overview & Problem Statement

The current rate-limiting implementation in `src/lib/request-guards.ts` relies on a local, in-memory Javascript `Map()` to track request counts per user/organization.

While sufficient for local development and basic testing, this implementation is fundamentally flawed for a production environment deployed on Google Cloud Platform (GCP):

1. **Horizontal Scaling Failure:** In-memory state is not shared across GCP instances (e.g., Cloud Run or GKE). A user can bypass limits entirely as traffic is load-balanced across multiple instances.
2. **Ephemeral Reset:** Serverless environments frequently spin instances up and down. Every restart wipes the rate limit history.
3. **Memory Leaks:** The current `Map()` indefinitely stores keys for every `routeKey:orgId:userId` combination. Because there is no garbage collection or TTL (Time To Live) cleanup mechanism, the server will eventually crash with an Out Of Memory (OOM) error under sustained traffic.

## 2. Proposed Architecture: The Hybrid Approach

To ensure maximum security, performance, and reliability, we will adopt a hybrid rate-limiting architecture utilizing both Cloudflare (Edge) and Redis (Application).

### Layer 1: Edge Rate Limiting (Cloudflare WAF)

**Goal:** Prevent volumetric attacks, DDoS, and severe API abuse before traffic ever reaches GCP infrastructure, saving compute costs.

- **Mechanism:** IP-based rate limiting via Cloudflare Dashboard / Terraform.
- **Scope:** Broad limit (e.g., 300-500 requests per minute per IP address).
- **Target:** All `/_serverFn/*` and `/api/*` routes.

### Layer 2: Business Logic Rate Limiting (Application Level)

**Goal:** Enforce strict usage limits based on business entities (User ID, Organization ID) regardless of what IP address the user connects from.

- **Mechanism:** Redis (Google Cloud Memorystore or Upstash Serverless Redis) integrated into `src/lib/request-guards.ts`.
- **Scope:** Strict limits (e.g., 30 mutations per minute per user per organization).
- **Advantages:** Redis provides atomic increments, automatic key expiration (TTL) eliminating memory leaks, and global state synchronization across all GCP instances.

## 3. Implementation Requirements

### 3.1 Infrastructure Changes

1. **Cloudflare:** Configure a Rate Limiting rule under Security > WAF to block IPs exceeding a high threshold of API requests.
2. **GCP/Upstash:** Provision a Redis instance.
   - _Recommendation:_ Upstash Serverless Redis is highly recommended for serverless/Cloud Run environments as it operates over REST (solving TCP connection limits) and scales to zero.

### 3.2 Application Changes (`src/lib/request-guards.ts`)

1. **Remove In-Memory State:** Delete the `const buckets = new Map<string, RateLimitBucket>();` implementation.
2. **Integrate Redis Client:** Install and configure a Redis client (e.g., `@upstash/redis`).
3. **Update `enforceRateLimit` Logic:**
   - Construct the Redis key: `ratelimit:${routeKey}:${orgId}:${userId}`
   - Execute an atomic Redis `INCR` command.
   - If the value is `1` (new key), set a Redis `EXPIRE` (TTL) matching the `windowMs` (e.g., 60 seconds).
   - If the value exceeds the `limit`, throw the `429 Rate Limit Exceeded` Response.
4. **Environment Variables:** Introduce `REDIS_URL` and `REDIS_TOKEN` to `.env`.
5. **Fail-Open Strategy:** If the Redis connection fails or times out, the function should log the error and _allow_ the request to proceed (Fail-Open) to prevent caching outages from bringing down the core application, relying on Cloudflare as the ultimate fallback.

## 4. Rollout Strategy

1. **Phase 1:** Provision Redis instance and inject environment variables into GCP staging/production.
2. **Phase 2:** Implement Cloudflare Edge rate limiting (Monitor mode first, then Enforce).
3. **Phase 3:** Merge PR replacing in-memory limits with Redis logic. Ensure `BYPASS_RATE_LIMITS=true` is maintained for the E2E test suite in GitHub Actions to prevent parallel test collisions.
