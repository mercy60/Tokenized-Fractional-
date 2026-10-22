// Copyright (c) 2026 Tokenized Fractional RWA Marketplace Contributors
// SPDX-License-Identifier: MIT

/**
 * Federated gateway degraded-mode behavior — Issue #886
 *
 * Defines and verifies what happens when one subgraph is unavailable while
 * the rest of the supergraph is healthy:
 *
 *   INTENDED BEHAVIOR: partial data with per-field errors (never a wholesale
 *   failure of the entire response).
 *
 *   - Queries that touch only healthy subgraphs' fields succeed exactly as
 *     if every subgraph were up.
 *   - Fields owned by the failed subgraph resolve to null and each affected
 *     root field gets its own error tagged with
 *     `extensions.code = 'SUBGRAPH_UNAVAILABLE'` and `extensions.subgraph`.
 *   - Because of ordinary GraphQL null propagation, a non-null root field
 *     whose subgraph is down nulls the entire `data` object (documented in
 *     backend/FEDERATION_ARCHITECTURE.md — "Degraded Mode").
 *   - Cross-subgraph entity joins keep whatever the healthy subgraph can
 *     serve (including @key fields it resolves locally); only fields owned
 *     by the dead subgraph are null + error.
 *
 * The unavailable subgraph is simulated through the gateway's `buildService`
 * seam, which replaces the users subgraph's data source with one that always
 * fails the way an unreachable service does (connection refused).
 */

import { LocalGraphQLDataSource } from '@apollo/gateway';
import { createFederatedGraphQLServer } from '../src/federation/gateway.js';
import { createAssetsSubgraph } from '../src/federation/subgraphs/assets/schema.js';
import { createUsersSubgraph } from '../src/federation/subgraphs/users/schema.js';
import { createTransactionsSubgraph } from '../src/federation/subgraphs/transactions/schema.js';
import { subgraphErrors } from '../src/federation/metrics.js';
import { entityCache } from '../src/federation/entityCache.js';

const CONTRACT_ID = 'CTEST123456789012345678901234567890123456789012';
const WALLET = 'GBUYER1234567890';
const DEAD_SUBGRAPH = 'users';

const mockDataLayer = {
  data: {
    [CONTRACT_ID]: {
      title: 'Federated Commercial Tower',
      location: 'New York',
      description: 'Prime commercial real estate',
      assetType: 'commercial_real_estate',
      totalShares: 1000,
      pricePerShare: 5000,
      availableShares: 800,
      paused: false,
    },
  },
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
  txs: [
    {
      transactionId: 'TX100',
      contractId: CONTRACT_ID,
      buyerAddress: WALLET,
      shareCount: 10,
      pricePerShare: 5000,
      totalCost: 50000,
      status: 'COMPLETED',
      timestamp: '2026-07-25T12:00:00Z',
    },
  ],
  getAllTransactions() {
    return this.txs;
  },
  getTransactionById(id) {
    return this.txs.find((t) => t.transactionId === id);
  },
  getTransactionsByAsset(contractId) {
    return this.txs.filter((t) => t.contractId === contractId);
  },
  getTransactionsByUser(wallet) {
    return this.txs.filter((t) => t.buyerAddress === wallet);
  },
};

/** Data source that always fails the way an unreachable service does. */
function unavailableDataSource(name) {
  return {
    async process() {
      throw new Error('connect ECONNREFUSED 10.0.0.5:4002');
    },
    sdl() {
      throw new Error(`Subgraph "${name}" is unavailable`);
    },
  };
}

describe('Federated gateway degraded mode (#886)', () => {
  let server;

  beforeAll(async () => {
    // Local schemas for the healthy subgraphs (used by the default in-process
    // data sources); the users subgraph's data source is replaced with a
    // permanently failing one to simulate that service being down.
    const schemas = {
      assets: createAssetsSubgraph(mockDataLayer),
      users: createUsersSubgraph(mockTransactionService),
      transactions: createTransactionsSubgraph(mockTransactionService),
    };

    ({ server } = await createFederatedGraphQLServer({
      dataLayer: mockDataLayer,
      transactionService: mockTransactionService,
      buildService: ({ name }) =>
        name === DEAD_SUBGRAPH
          ? unavailableDataSource(name)
          : new LocalGraphQLDataSource(schemas[name]),
    }));
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    entityCache.invalidateType('RWA');
    entityCache.invalidateType('User');
    entityCache.invalidateType('Transaction');
  });

  async function execute(query) {
    const response = await server.executeOperation({ query }, { contextValue: { isAdmin: true } });
    return response.body.kind === 'single' ? response.body.singleResult : response.body;
  }

  async function unavailableCounter(subgraph) {
    const metric = await subgraphErrors.get();
    return metric.values
      .filter(
        (v) => v.labels.subgraph === subgraph && v.labels.error_type === 'SUBGRAPH_UNAVAILABLE',
      )
      .reduce((sum, v) => sum + v.value, 0);
  }

  test('query touching only healthy subgraphs succeeds with no errors while users is down', async () => {
    const body = await execute(`{
      assets { contractId title location }
      transactions(limit: 5) { transactionId totalCost }
    }`);

    expect(body.errors).toBeUndefined();
    expect(body.data.assets).toHaveLength(1);
    expect(body.data.assets[0].contractId).toBe(CONTRACT_ID);
    expect(body.data.transactions).toHaveLength(1);
    expect(body.data.transactions[0].transactionId).toBe('TX100');
  });

  test('mixed query returns partial data: healthy fields present, dead field null with a per-field error', async () => {
    const body = await execute(`{
      assets { contractId title }
      user(walletAddress: "${WALLET}") { walletAddress kycStatus }
    }`);

    // Healthy subgraph data is unaffected
    expect(body.data.assets).toHaveLength(1);
    expect(body.data.assets[0].title).toBe('Federated Commercial Tower');

    // Dead subgraph's nullable field resolves to null
    expect(body.data.user).toBeNull();

    // ...with a clear error attributed to the field and the failed subgraph
    expect(body.errors).toHaveLength(1);
    const [error] = body.errors;
    expect(error.message).toMatch(/users.*unavailable/i);
    expect(error.path).toEqual(['user']);
    expect(error.extensions.code).toBe('SUBGRAPH_UNAVAILABLE');
    expect(error.extensions.subgraph).toBe('users');
  });

  test('query touching only the dead subgraph returns null field plus error, not a transport failure', async () => {
    const body = await execute(`{ user(walletAddress: "${WALLET}") { walletAddress } }`);

    expect(body.data).toEqual({ user: null });
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].extensions.code).toBe('SUBGRAPH_UNAVAILABLE');
    expect(body.errors[0].path).toEqual(['user']);
  });

  test('aliased dead fields are attributed to the response key', async () => {
    const body = await execute(`{
      assets { contractId }
      u2: user(walletAddress: "${WALLET}") { walletAddress }
    }`);

    expect(body.data.assets).toHaveLength(1);
    expect(body.data.u2).toBeNull();
    expect(body.errors[0].path).toEqual(['u2']);
  });

  test('non-null root field owned by the dead subgraph nulls data (GraphQL null propagation) but keeps a path-tagged error', async () => {
    // userShareHoldings: [UserHolding!]! is non-null, so the error propagates
    // to the root `data` object per the GraphQL spec.
    const body = await execute(`{
      assets { contractId }
      userShareHoldings(walletAddress: "${WALLET}") { contractId }
    }`);

    expect(body.data).toBeNull();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].path).toEqual(['userShareHoldings']);
    expect(body.errors[0].extensions.code).toBe('SUBGRAPH_UNAVAILABLE');
    expect(body.errors[0].extensions.subgraph).toBe('users');
  });

  test('cross-subgraph entity join keeps fields the live subgraph can serve itself', async () => {
    // walletAddress is a @key field of User, so the transactions subgraph can
    // answer it without calling users; kycStatus is owned by users and fails.
    const body = await execute(`{
      transactions(limit: 5) {
        transactionId
        buyer { walletAddress kycStatus }
      }
    }`);

    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].extensions.subgraph).toBe('users');
    expect(body.errors[0].extensions.code).toBe('SUBGRAPH_UNAVAILABLE');

    expect(body.data.transactions[0].transactionId).toBe('TX100');
    expect(body.data.transactions[0].buyer.walletAddress).toBe(WALLET);
    expect(body.data.transactions[0].buyer.kycStatus).toBeNull();
  });

  test('subgraph unavailability increments the subgraph error metric', async () => {
    const before = await unavailableCounter(DEAD_SUBGRAPH);

    const body = await execute(`{ user(walletAddress: "${WALLET}") { walletAddress } }`);
    expect(body.errors[0].extensions.code).toBe('SUBGRAPH_UNAVAILABLE');

    const after = await unavailableCounter(DEAD_SUBGRAPH);
    expect(after).toBeGreaterThan(before);
  });
});
