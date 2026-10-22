// Copyright (c) 2026 Tokenized Fractional RWA Marketplace Contributors
// SPDX-License-Identifier: MIT

/**
 * GraphQL query complexity enforcement at every entrypoint — Issue #884
 *
 * Verifies that a deliberately expensive query is rejected *consistently*:
 *
 *   1. at the federated gateway (`backend/src/federation/gateway.js`), and
 *   2. directly against each individual subgraph service
 *      (`backend/services/{assets,users,transactions}`), exercising the very
 *      factory (`services/shared/subgraphServer.js`) their `server.js` uses —
 *      defense in depth for a misconfigured deployment where a subgraph port
 *      is accidentally exposed without the gateway in front of it.
 *
 * Two bomb shapes are used: a field-count bomb (>50 fields) and a
 * complexity-score bomb (nested list selections whose weighted score exceeds
 * 100 while staying under the field/depth caps), proving the limits are not
 * redundant with each other.
 *
 * Relationship between the two analysis modules (AC 3):
 *   - `backend/graphql/complexity.js` is the ONLY module wired into a served
 *     GraphQL endpoint. It backs:
 *       /api/graphql   (graphql/index.js, per-tier limits)
 *       /graphql       (src/federation/gateway.js, standard-tier limits)
 *       standalone subgraph services (services/shared/subgraphServer.js)
 *   - `graphql/analysis/queryAnalyzer.js` (top-level `graphql/` directory) is
 *     NOT imported by any server — nothing in the runtime request path uses
 *     it. It is an advisory analysis/reporting utility for the standalone
 *     persisted-query tooling (registration/versioning/analytics docs) and is
 *     superseded by `backend/graphql/complexity.js` for enforcement.
 */

import { createFederatedGraphQLServer } from '../src/federation/gateway.js';
import { createSubgraphServiceServer } from '../services/shared/subgraphServer.js';
import {
  typeDefs as assetsServiceTypeDefs,
  resolvers as assetsServiceResolvers,
} from '../services/assets/resolvers.js';
import {
  typeDefs as usersServiceTypeDefs,
  resolvers as usersServiceResolvers,
} from '../services/users/resolvers.js';
import {
  typeDefs as transactionsServiceTypeDefs,
  resolvers as transactionsServiceResolvers,
} from '../services/transactions/resolvers.js';

const mockDataLayer = {
  data: {},
  loadData() {
    return this.data;
  },
  saveData(d) {
    this.data = d;
  },
  validateContractId: (id) => typeof id === 'string' && id.length >= 50 && id.startsWith('C'),
  validateRwaBody: () => null,
  syncSearchIndex() {},
};

const mockTransactionService = {
  txs: [],
  getAllTransactions() {
    return this.txs;
  },
  getTransactionById() {
    return undefined;
  },
  getTransactionsByAsset() {
    return [];
  },
  getTransactionsByUser() {
    return [];
  },
};

/** 59 aliased selections under one root list field => 60 fields (max 50). */
function fieldCountBomb(rootField, scalarField) {
  const selections = Array.from({ length: 59 }, (_, i) => `f${i}: ${scalarField}`).join(' ');
  return `{ ${rootField} { ${selections} } }`;
}

/**
 * Three aliased `documents` list selections nested under the root list field:
 * 16 fields total (under the 50-field cap) but weighted score 135 > 100
 * because nested list selections multiply by the list factor.
 */
function complexityScoreBomb() {
  const blocks = Array.from(
    { length: 3 },
    (_, i) => `d${i}: documents { name hash mimeType uploadedAt }`,
  ).join(' ');
  return `{ assets { ${blocks} } }`;
}

async function execute(server, query) {
  const response = await server.executeOperation({ query }, { contextValue: { isAdmin: true } });
  return response.body.kind === 'single' ? response.body.singleResult : response.body;
}

describe('GraphQL complexity limits at the federated gateway (#884)', () => {
  let server;

  beforeAll(async () => {
    ({ server } = await createFederatedGraphQLServer({
      dataLayer: mockDataLayer,
      transactionService: mockTransactionService,
    }));
  });

  afterAll(async () => {
    await server.stop();
  });

  test('rejects a query exceeding the field-count limit before execution', async () => {
    const body = await execute(server, fieldCountBomb('assets', 'contractId'));

    expect(body.data).toBeUndefined();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].message).toMatch(/60 fields \(max: 50\)/);
    expect(body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });

  test('rejects a query exceeding the complexity-score limit before execution', async () => {
    const body = await execute(server, complexityScoreBomb());

    expect(body.data).toBeUndefined();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].message).toMatch(
      /complexity score \(135\) exceeds maximum allowed \(100\)/,
    );
    expect(body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });

  test('allows a normal query within the limits', async () => {
    const body = await execute(server, '{ assets { contractId title location } }');

    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({ assets: [] });
  });
});

describe('GraphQL complexity limits at each standalone subgraph service (#884)', () => {
  // Each entry mirrors the service started by the corresponding
  // backend/services/<name>/server.js — same factory, same typeDefs/resolvers.
  const services = [
    {
      name: 'assets',
      rootField: 'assets',
      scalarField: 'contractId',
      validQuery: '{ assets(limit: 1) { contractId title } }',
      typeDefs: assetsServiceTypeDefs,
      resolvers: assetsServiceResolvers,
    },
    {
      name: 'users',
      rootField: 'users',
      scalarField: 'userId',
      validQuery: '{ users(limit: 1) { userId walletAddress } }',
      typeDefs: usersServiceTypeDefs,
      resolvers: usersServiceResolvers,
    },
    {
      name: 'transactions',
      rootField: 'transactions',
      scalarField: 'transactionId',
      validQuery: '{ transactions(limit: 1) { transactionId status } }',
      typeDefs: transactionsServiceTypeDefs,
      resolvers: transactionsServiceResolvers,
    },
  ];

  describe.each(services)('$name subgraph', (service) => {
    let server;

    beforeAll(async () => {
      server = createSubgraphServiceServer({
        typeDefs: service.typeDefs,
        resolvers: service.resolvers,
      });
      await server.start();
    });

    afterAll(async () => {
      await server.stop();
    });

    test('rejects the same field-count bomb directly against the subgraph', async () => {
      const body = await execute(server, fieldCountBomb(service.rootField, service.scalarField));

      expect(body.data).toBeUndefined();
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].message).toMatch(/60 fields \(max: 50\)/);
      expect(body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
    });

    test('allows a normal query within the limits', async () => {
      const body = await execute(server, service.validQuery);

      expect(body.errors).toBeUndefined();
      expect(body.data).toBeDefined();
    });
  });
});
