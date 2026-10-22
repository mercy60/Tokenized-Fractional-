// Copyright (c) 2026 Tokenized Fractional RWA Marketplace Contributors
// SPDX-License-Identifier: MIT

/**
 * federation/gateway.js
 *
 * Apollo Federation Gateway & Subgraph Server factory.
 *
 * Composes the three in-process subgraphs (Assets, Users, Transactions) into
 * a unified GraphQL supergraph schema served at `/graphql`.
 *
 * Degraded mode (subgraph unavailable) — Issue #886
 * ───────────────────────────────────────────────────
 * The gateway's intended degraded-mode behavior is **partial data with
 * per-field errors**, never a wholesale failure of the whole response:
 *
 *   - A query that touches only the fields of healthy subgraphs succeeds
 *     exactly as if every subgraph were up.
 *   - When a subgraph cannot be reached (its data source throws) the fetch
 *     for that subgraph fails in isolation: fields resolved by healthy
 *     subgraphs are still returned, an error describing the failure is
 *     attached to the response, and the fields owned by the failed subgraph
 *     resolve to `null` (subject to ordinary GraphQL null-propagation —
 *     a non-null field whose subgraph failed nulls its nearest nullable
 *     parent, and a non-null *root* field nulls the whole `data` object).
 *   - Failures are scoped to a single fetch; they do not cancel sibling
 *     fetches already in flight, so one dead subgraph never blocks data
 *     that is available.
 *
 * This contract is exercised by `__tests__/federationDegradedMode.test.js`,
 * which injects an always-failing data source for one subgraph via the
 * optional `buildService` option.
 *
 * Query complexity limits — Issue #884
 * ─────────────────────────────────────
 * Every operation arriving at the gateway is validated against the same
 * limits enforced by the standalone GraphQL Yoga server
 * (`backend/graphql/complexity.js`, standard-tier defaults:
 * GRAPHQL_MAX_COMPLEXITY=100, GRAPHQL_MAX_DEPTH=10, GRAPHQL_MAX_FIELDS=50)
 * *before* the query plan is executed. See `backend/FEDERATION_ARCHITECTURE.md`
 * for the defense-in-depth story across gateway and subgraphs.
 */

import { GraphQLError, parse } from 'graphql';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloGateway, LocalGraphQLDataSource } from '@apollo/gateway';
import { createAssetsSubgraph, typeDefs as assetsTypeDefs } from './subgraphs/assets/schema.js';
import { createUsersSubgraph, typeDefs as usersTypeDefs } from './subgraphs/users/schema.js';
import {
  createTransactionsSubgraph,
  typeDefs as transactionsTypeDefs,
} from './subgraphs/transactions/schema.js';
import { federationMetricsMiddleware, subgraphErrors } from './metrics.js';
import { complexityValidationRule } from '../../graphql/complexity.js';

/**
 * Build the data source the gateway uses to reach a subgraph.
 *
 * The default wires each composed subgraph to its in-process schema
 * (zero network I/O). Callers — tests in particular — can override this to
 * simulate an unavailable subgraph (see the degraded-mode note above) or to
 * point a subgraph at a remote endpoint.
 *
 * @param {Record<string, import('graphql').GraphQLSchema>} subgraphSchemas
 * @returns {(serviceDef: { name: string }) => import('@apollo/gateway').GraphQLDataSource}
 */
function localDataSourceFactory(subgraphSchemas) {
  return ({ name }) => {
    const schema = subgraphSchemas[name];
    if (!schema) {
      throw new Error(`No local schema registered for subgraph "${name}"`);
    }
    return new LocalGraphQLDataSource(schema);
  };
}

/**
 * Derive the response-key paths a failed subgraph fetch affects.
 *
 * For a fetch of root fields the affected response paths are exactly the
 * top-level fields of the subgraph operation (aliases preserved). Entity
 * fetches (`_entities`) can span many parent positions that are only known
 * from the response, so they yield `null` — the error still carries
 * `extensions.subgraph`, and the null fields identify the affected data.
 *
 * @param {import('graphql').DocumentNode | string | undefined} source - the
 *   subgraph fetch document (Apollo passes either a parsed document or the
 *   operation string, depending on planner version)
 * @returns {Array<[string]> | null}
 */
function affectedRootFieldPaths(source) {
  try {
    const document = typeof source === 'string' ? parse(source) : source;
    const operation = document?.definitions?.find((def) => def.kind === 'OperationDefinition');
    const collect = (selections) => {
      const paths = [];
      for (const selection of selections || []) {
        if (selection.kind === 'Field') {
          paths.push([selection.alias?.value || selection.name.value]);
        } else if (selection.kind === 'InlineFragment') {
          paths.push(...collect(selection.selectionSet?.selections));
        }
      }
      return paths;
    };
    const paths = collect(operation?.selectionSet?.selections);
    if (paths.length === 0) return null;
    if (paths.length === 1 && paths[0][0] === '_entities') return null;
    return [...new Map(paths.map((p) => [p[0], p])).values()];
  } catch {
    return null;
  }
}

/**
 * Wrap a subgraph data source with degraded-mode observability and error
 * normalization (Issue #886):
 *
 *   - Errors *returned* by the subgraph (resolver failures) are counted in
 *     the `graphql_federation_subgraph_errors_total` Prometheus counter.
 *   - Errors *thrown* by the subgraph data source (the subgraph being
 *     unreachable — connection refused, timeout, process down) are converted
 *     into a subgraph-shaped error response carrying
 *     `extensions.code = 'SUBGRAPH_UNAVAILABLE'` and the subgraph name, so
 *     Apollo Gateway attributes the failure to the affected field path
 *     instead of surfacing an anonymous transport error. They are counted
 *     as `error_type="SUBGRAPH_UNAVAILABLE"`.
 *
 * The wrapper is applied to every data source — including ones supplied by a
 * caller-provided `buildService` — so the contract holds no matter how a
 * subgraph is wired.
 *
 * @param {string} serviceName
 * @param {import('@apollo/gateway').GraphQLDataSource} dataSource
 * @returns {import('@apollo/gateway').GraphQLDataSource}
 */
function instrumentSubgraphDataSource(serviceName, dataSource) {
  return {
    async process(options) {
      try {
        const response = await dataSource.process(options);
        if (Array.isArray(response?.errors)) {
          for (const error of response.errors) {
            subgraphErrors.inc({
              subgraph: serviceName,
              error_type: error?.extensions?.code || 'GRAPHQL_ERROR',
            });
          }
        }
        return response;
      } catch (error) {
        // The subgraph could not be reached at all (connection refused,
        // timeout, process down). Turn the transport failure into a
        // subgraph-shaped error response so Apollo Gateway attributes it to
        // the affected field path with `extensions.serviceName` — exactly
        // like an execution error — while sibling subgraph fetches keep
        // returning data.
        subgraphErrors.inc({ subgraph: serviceName, error_type: 'SUBGRAPH_UNAVAILABLE' });
        const message = `Subgraph "${serviceName}" is unavailable: ${error?.message || 'unknown failure'}`;
        const extensions = {
          code: 'SUBGRAPH_UNAVAILABLE',
          subgraph: serviceName,
          serviceName,
        };
        const paths = affectedRootFieldPaths(options?.document ?? options?.request?.query);
        // Attribute the failure to every response field this fetch was
        // responsible for, so each null field has a matching per-field error.
        const errors = paths
          ? paths.map(
              (path) =>
                new GraphQLError(message, {
                  originalError: error,
                  path,
                  extensions: { ...extensions },
                }),
            )
          : [new GraphQLError(message, { originalError: error, extensions })];
        return { errors };
      }
    },
    sdl: (...args) => dataSource.sdl?.(...args),
    healthCheck: (...args) => dataSource.healthCheck?.(...args),
  };
}

export async function createFederatedGraphQLServer({
  dataLayer,
  transactionService,
  logger,
  buildService,
}) {
  // Build individual subgraph schemas
  const assetsSchema = createAssetsSubgraph(dataLayer);
  const usersSchema = createUsersSubgraph(transactionService);
  const transactionsSchema = createTransactionsSubgraph(transactionService);

  const subgraphSchemas = {
    assets: assetsSchema,
    users: usersSchema,
    transactions: transactionsSchema,
  };

  // Compose the subgraphs locally (zero network overhead, in-process
  // composition). ApolloGateway expects `{ name, typeDefs }` service
  // definitions — `schema` is only used to build the executable subgraphs.
  const gateway = new ApolloGateway({
    localServiceList: [
      { name: 'assets', typeDefs: assetsTypeDefs },
      { name: 'users', typeDefs: usersTypeDefs },
      { name: 'transactions', typeDefs: transactionsTypeDefs },
    ],
    // Local composition still routes *execution* through a data source per
    // subgraph. Without an explicit builder the gateway would construct a
    // RemoteGraphQLDataSource with an undefined URL and every federated
    // query would fail, so always provide one. Every data source — including
    // caller-supplied overrides used to simulate an unavailable subgraph —
    // is wrapped with degraded-mode error normalization/metrics.
    buildService: (serviceDef) =>
      instrumentSubgraphDataSource(
        serviceDef.name,
        (buildService || localDataSourceFactory(subgraphSchemas))(serviceDef),
      ),
  });

  const server = new ApolloServer({
    gateway,
    // Query complexity / depth / field-count limits (Issue #884): reject
    // abusive operations during validation, before query planning or any
    // subgraph fetch happens. Limits come from backend/graphql/complexity.js
    // (GRAPHQL_MAX_* env overrides, standard-tier defaults).
    validationRules: [complexityValidationRule()],
    includeStacktraceInErrorResponses: process.env.NODE_ENV !== 'production',
  });

  await server.start();

  const middleware = expressMiddleware(server, {
    context: async ({ req }) => ({
      isAdmin: req.headers['x-admin-key'] || req.isAdmin || false,
      walletAddress: req.walletAddress || req.headers['x-wallet-address'] || null,
      requestId: req.requestId,
    }),
  });

  return {
    server,
    gateway,
    middleware: [federationMetricsMiddleware, middleware],
    subgraphs: subgraphSchemas,
  };
}
