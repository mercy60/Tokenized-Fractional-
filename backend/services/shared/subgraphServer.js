// Copyright (c) 2026 Tokenized Fractional RWA Marketplace Contributors
// SPDX-License-Identifier: MIT

/**
 * services/shared/subgraphServer.js
 *
 * Shared ApolloServer factory for the standalone federated subgraph services
 * (`services/assets`, `services/users`, `services/transactions`).
 *
 * Issue #884 — defense in depth: every entrypoint into the GraphQL surface
 * enforces the same query complexity / depth / field-count limits from
 * `backend/graphql/complexity.js`, *including each subgraph on its own*, so a
 * subgraph port that is accidentally exposed (misconfigured deployment that
 * bypasses the gateway) is still protected:
 *
 *   - Federated gateway (/graphql)         — validationRules in src/federation/gateway.js
 *   - Monolith GraphQL API (/api/graphql)  — validationRules in graphql/index.js (tiered)
 *   - Standalone subgraph services         — this factory
 *
 * Limits default to the standard-tier values (GRAPHQL_MAX_COMPLEXITY=100,
 * GRAPHQL_MAX_DEPTH=10, GRAPHQL_MAX_FIELDS=50, each env-overridable) and can
 * be overridden per service via the `limits` option.
 *
 * `__tests__/graphqlComplexityEnforcement.test.js` exercises this factory
 * with each subgraph's real typeDefs/resolvers.
 */

import { ApolloServer } from '@apollo/server';
import { buildSubgraphSchema } from '@apollo/subgraph';
import { complexityValidationRule } from '../../graphql/complexity.js';

/**
 * Create an ApolloServer for a standalone subgraph service with query
 * complexity validation applied before execution.
 *
 * @param {object} options
 * @param {import('graphql').DocumentNode} options.typeDefs - federation SDL
 *   (buildSubgraphSchema handles the @link/@key/@provides directives and
 *   adds the _service/_entities machinery)
 * @param {object} options.resolvers
 * @param {{ maxComplexity?: number, maxDepth?: number, maxFields?: number }} [options.limits]
 * @returns {ApolloServer}
 */
export function createSubgraphServiceServer({ typeDefs, resolvers, limits = {} }) {
  return new ApolloServer({
    schema: buildSubgraphSchema([{ typeDefs, resolvers }]),
    validationRules: [complexityValidationRule(limits)],
    includeStacktraceInErrorResponses: process.env.NODE_ENV !== 'production',
  });
}
