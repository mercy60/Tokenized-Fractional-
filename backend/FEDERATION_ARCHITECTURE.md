# GraphQL Federation Architecture Documentation

This document describes the GraphQL Federation architecture for the Tokenized RWA Marketplace backend.

## Overview

The GraphQL schema is decomposed into domain-driven **subgraphs** composed into a unified supergraph via **Apollo Gateway**:

```
                  ┌────────────────────────┐
                  │     Apollo Gateway     │  (/graphql)
                  └───────────┬────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
         ▼                    ▼                    ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  Assets Subgraph │ │  Users Subgraph  │ │Transactions S.G. │
│ (/graphql/assets)│ │ (/graphql/users) │ │(/graphql/trans..)│
└──────────────────┘ └──────────────────┘ └──────────────────┘
```

All subgraphs execute **in-process** via Apollo's `LocalGraphQLDataSource` for maximum performance (zero network I/O overhead between Gateway and Subgraphs).

---

## Service Boundaries & Entity Types

### 1. Assets Subgraph (`RWA` entity)
- **Entity**: `RWA @key(fields: "contractId")`
- **Responsibilities**: RWA metadata, valuation, available shares, listing status, approval lifecycle, and search.
- **Key Fields**: `contractId` (primary key on Stellar network).

### 2. Users Subgraph (`User` entity)
- **Entity**: `User @key(fields: "walletAddress")`
- **Responsibilities**: User profile, KYC status, tier, and share holdings across assets.
- **External References**: References `RWA` from Assets subgraph to associate holdings with asset details.

### 3. Transactions Subgraph (`Transaction` entity)
- **Entity**: `Transaction @key(fields: "transactionId")`
- **Responsibilities**: Off-chain and on-chain transaction records, status tracking, and volume queries.
- **External References**: Cross-service joins to `RWA` (`contractId`) and `User` (`buyerAddress`).

---

## Cross-Service Joins & Entity Resolution

Entities are resolved across subgraphs using Apollo Federation v2 `@key` and `__resolveReference` resolvers.

Example cross-service query:
```graphql
query {
  transactions(limit: 5) {
    transactionId
    totalCost
    asset {
      title
      location
      pricePerShare
    }
    buyer {
      walletAddress
      kycStatus
    }
  }
}
```

Query Planner execution:
1. Queries `transactions` from Transactions Subgraph.
2. Extracts `contractId` and `buyerAddress` representations.
3. Invokes `Assets` and `Users` subgraphs' `_entities` resolvers concurrently.
4. Merges returned entities into the final GraphQL response.

---

## Entity Ownership Policy (which subgraph is authoritative)

Every entity has **exactly one authoritative subgraph** and every *value*
field (any field carrying data) is defined in that one subgraph only. When
subgraphs overlap on an entity, the non-owner declares a **key-only stub**
that can resolve nothing but the reference itself (Issue #883):

| Entity | `@key` | Authoritative subgraph | Owns (value fields) | Stub declared in |
|---|---|---|---|---|
| `RWA` | `contractId` | **assets** | `title`, `location`, `description`, `assetType`, `totalShares`, `pricePerShare`, `availableShares`, `isPaused`, `documents`, `createdAt`, `updatedAt` | users (key field only), transactions (key field only) |
| `User` | `walletAddress` | **users** | `kycStatus`, `tier`, `holdings` | transactions (key field only) |
| `Transaction` | `transactionId` | **transactions** | `contractId`, `buyerAddress`, `shareCount`, `pricePerShare`, `totalCost`, `status`, `txHash`, `timestamp` | — (none) |

### `@key` / reference-resolution contract

- A stub is exactly `type X @key(fields: "…") { <keyField> }` — the key
  field is **not** marked `@external`. Federation v2 treats `@key` fields as
  implicitly shareable between subgraphs that declare the same entity; an
  `@external` key field instead makes the entity unreferenceable from that
  subgraph and fails composition (this was a real bug, fixed alongside
  Issue #883).
- `__resolveReference` is implemented **only on the owner**: assets resolves
  `RWA`, users resolves `User`, transactions resolves `Transaction`. Stubs
  never implement it and never serve non-key fields.
- Consumers join by returning a representation (`{ __typename, <keyField> }`)
  from a resolver; the gateway invokes the owner's `_entities` resolver and
  merges the result (optionally served from `entityCache`, see below).
- Because key fields are resolved from their single owner and value fields
  exist in exactly one subgraph, there is no ambiguity about who answers a
  field — the query planner cannot even ask a stub for one.

### Adding a field (for new contributors)

1. Value field → add it **only** to the owning subgraph's type and resolvers.
2. Need it from another subgraph? Join through the `@key` reference; do not
   duplicate the field and do not reach for `@shareable` — two subgraphs
   serving one field is exactly the overlap this policy forbids.
3. New entity → declare it in one subgraph with `@key`, add key-only stubs
   where other subgraphs must reference it, implement `__resolveReference`
   on the owner only.

### Composition layers in this repository

The same ownership split exists in each of the repo's GraphQL composition
mechanisms; only the mechanism differs:

- **In-process Apollo Federation** (`src/federation/gateway.js`, served at
  `/graphql`) — the live path described throughout this document.
- **Standalone subgraph services** (`backend/services/{assets,users,transactions}`
  composed by `backend/gateway/` via `IntrospectAndCompose`) — same split:
  `Asset` owned by assets, `User` owned by users (key `userId` — note the
  standalone trio keys `User` on `userId`, the in-process federation keys it
  on `walletAddress`), `Transaction` owned by transactions. Each
  `schema.graphql` declares key-only `@external` stubs for the foreign
  entities, with `@provides` fields served inline exactly as declared.
- **Schema stitching layer** (`graphql-stitching.js`, Issue #294) — a
  declarative subschema/merge configuration (`rwaSubschema`,
  `transactionSubschema`, conflict resolvers). In `src/app.js` only its
  metrics, schema version and config are consumed (status/metrics
  endpoints); it does not resolve entities or answer queries, so the
  ownership and cache-invalidation rules above are unaffected by it.

Entity ownership questions are therefore always answered by the table
above regardless of which layer carries the query.

---

## Degraded Mode: Subgraph Unavailability

**Intended behavior (Issue #886): partial data with per-field errors — the gateway
never fails a whole response just because one subgraph is down.**

The three subgraphs execute behind per-subgraph data sources. A data-source
failure (connection refused, timeout, crashed process) is scoped to the fetch
that hit it; sibling fetches for other subgraphs keep running and their data is
returned. This is the behavior the GraphQL specification permits for partial
responses, and it is asserted by `__tests__/federationDegradedMode.test.js`,
which kills the `users` subgraph through the gateway's `buildService` option.

| Scenario | Response |
|---|---|
| Query touches only healthy subgraphs' fields | Full success — identical to all-subgraphs-up, zero errors |
| Mixed query (healthy + dead nullable field) | Healthy fields present, dead field `null`, one error per affected field |
| Query touches only the dead subgraph | Affected fields `null` + errors (HTTP-level GraphQL response, not a transport failure) |
| Dead field is **non-null at root** (e.g. `userShareHoldings`) | `data: null` — GraphQL null propagation nulls the nearest nullable parent, which at root is `data` itself |
| Cross-subgraph entity join (`transactions { buyer { … } }`) | Fields the live subgraph can serve (including `@key` fields it resolves locally) still return; only fields owned by the dead subgraph are `null` + error |

Error shape for an unreachable subgraph:

```json
{
  "message": "Subgraph \"users\" is unavailable: connect ECONNREFUSED …",
  "path": ["user"],
  "extensions": {
    "code": "SUBGRAPH_UNAVAILABLE",
    "subgraph": "users",
    "serviceName": "users"
  }
}
```

- For root-field fetches the gateway attributes one error per affected
  response field (aliases preserved), so every `null` field has a matching
  path-tagged error.
- For entity-resolution (`_entities`) fetches the affected parent positions
  are only known from the response, so the error carries
  `extensions.subgraph` but no `path`; the `null` fields still identify the
  affected data.
- Errors *returned* by a reachable subgraph (resolver failures) are wrapped
  by Apollo Gateway with `extensions.serviceName` as usual.

### Circuit breaker / fallback status

The in-process gateway keeps **no failure state**: a failed fetch is not
remembered, the next request simply retries the subgraph (fail-open per
request, no caching of outages, no request shedding). The
`createCircuitBreaker` helper in `backend/services/shared/errorHandler.js`
belongs to the standalone HTTP `serviceClient` path used by the separately
deployed `backend/services/*` subgraphs; it is not in the in-process gateway's
request path. If per-subgraph retry/backoff or breaker semantics are ever
needed at the gateway, they belong in the `buildService` seam.

### Observability

`graphql_federation_subgraph_errors_total{subgraph, error_type}` is
incremented for every subgraph failure:
- `error_type="SUBGRAPH_UNAVAILABLE"` — the data source itself failed
  (unreachable subgraph),
- otherwise the subgraph-reported error's `extensions.code`.

---

## Query Complexity Enforcement (defense in depth)

Every GraphQL entrypoint enforces the same limits from
`backend/graphql/complexity.js` **before** the operation executes, so abusive
queries are rejected during validation — no query planning, no subgraph
fetches (Issue #884):

| Entrypoint | Where limits are applied | Limits |
|---|---|---|
| Federated gateway `/graphql` | `src/federation/gateway.js` → `validationRules` | standard tier (`GRAPHQL_MAX_COMPLEXITY=100`, `GRAPHQL_MAX_DEPTH=10`, `GRAPHQL_MAX_FIELDS=50`, env-overridable) |
| Monolith GraphQL API `/api/graphql` | `graphql/index.js` → `validationRules` | per-tier (`basic`/`standard`/`premium`/`admin` via `x-user-tier`) |
| Standalone subgraph services (ports 4001-4003) | `services/shared/subgraphServer.js` (used by each `services/*/server.js`) | standard tier |

The per-subgraph row is the defense-in-depth half: a subgraph port that is
accidentally exposed (a misconfigured deployment that bypasses the gateway)
is still protected, and the same deliberately expensive query is rejected
consistently no matter which entrypoint receives it — asserted by
`__tests__/graphqlComplexityEnforcement.test.js` against the gateway **and**
each individual subgraph service.

### Which module actually enforces? (`complexity.js` vs `queryAnalyzer.js`)

- **`backend/graphql/complexity.js` is the only module wired into a served
  endpoint.** Its `complexityValidationRule` backs all three rows of the
  table above. Change this file to change what gets rejected.
- **`graphql/analysis/queryAnalyzer.js` (top-level `graphql/` directory) is
  not imported by any server.** It is an advisory scoring/reporting utility
  for the standalone persisted-query tooling (registration, versioning,
  analytics — see `GRAPHQL_IMPLEMENTATION*.md`); its thresholds never reject
  traffic. For enforcement it is superseded by `backend/graphql/complexity.js`.

---

## Performance Optimizations & Caching

### In-Memory Entity Cache (`entityCache.js`)

A per-process, TTL-based cache that short-circuits redundant `_entities`
lookups during batch or nested queries (Issue #883 — invalidation strategy):

**Strategy: TTL-based expiry *plus* explicit, event-driven invalidation on
owner mutations — nothing more.** There is no cross-process invalidation and
no change-stream/event bus behind it.

| Entity | Written when | Explicitly invalidated when | Otherwise expires via |
|---|---|---|---|
| `RWA` | `asset` query / `__resolveReference` miss | **All six assets mutations**: `createAsset`, `updateAsset`, `deleteAsset`, `approveAsset`, `pauseAsset`, `unpauseAsset` (same-process only) | 30s TTL per entry (purged by the 60s sweep) |
| `User` | `user` query / `__resolveReference` | *never* — no in-process mutation mutates users | 30s TTL only |
| `Transaction` | `transaction` query / `__resolveReference` | *never* — no in-process mutation mutates transactions | 30s TTL only |

Configuration: 30-second TTL, 500 entries per entity type (oldest evicted
first), expired entries swept every 60 seconds.

**Conditions under which stale cross-subgraph data can be served** (all
bounded by the 30-second TTL):

1. **Writes that bypass the assets mutations.** The REST API
   (`POST`/`PATCH` `/api/v1/rwa…`) invalidates the *Redis REST cache* but not
   the federation entity cache, as do direct edits of the backing data file
   or database. A subsequent cross-subgraph join can serve the previous
   `RWA` snapshot for up to 30s.
2. **Multi-replica deployments.** The cache is an in-process `Map` (see
   `k8s/backend-deployment.yaml`, 2 replicas). A mutation handled by pod A
   invalidates only pod A's cache; pod B keeps serving its cached copy until
   its TTL lapses — explicit invalidation is *not* shared between pods.
3. **`User` / `Transaction` have no invalidation events at all** — any
   out-of-band change to user or transaction records (e.g. written by
   another service) is visible to the federation layer only after the 30s
   TTL expires.
4. **Capacity evictions are correctness-safe** (they only cause extra
   subgraph fetches), but a burst exceeding 500 entries per type churns the
   cache and lowers the hit rate rather than serving stale data.

If stronger freshness is required, the invalidation path must become
event-driven across processes (e.g. Redis pub/sub invalidation messages on
mutation, mirroring the WebSocket broadcast adapter) — that is explicitly
**not** implemented today.

### Observability & Metrics (`metrics.js`)
Prometheus metrics exported at `/metrics`:
- `graphql_federation_query_duration_seconds` — Overall Gateway request duration histogram.
- `graphql_federation_subgraph_duration_seconds` — Per-subgraph request duration histogram.
- `graphql_federation_entity_cache_hits_total` — Entity cache hits.
- `graphql_federation_entity_cache_misses_total` — Entity cache misses.
- `graphql_federation_subgraph_errors_total` — Subgraph execution error counts.

---

## Schema Governance Process

1. **Subgraph Independence**: Each team/service owns its subgraph schema file in `backend/src/federation/subgraphs/`.
2. **Composition Validation**: CI checks validate schema composition using `@apollo/gateway` before merging PRs.
3. **Backward Compatibility**: Non-breaking additions are preferred. Deprecated fields are tagged with `@deprecated`.
