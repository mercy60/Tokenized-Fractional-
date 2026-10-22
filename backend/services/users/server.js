// Users Service - Federated GraphQL Server
// This is a standalone federated service for user management

import { startStandaloneServer } from '@apollo/server/standalone';
import { resolvers, typeDefs } from './resolvers.js';
import { createSubgraphServiceServer } from '../shared/subgraphServer.js';

const PORT = process.env.USERS_SERVICE_PORT || 4002;

// Create Apollo Server with Federation support.
// Query complexity limits are enforced here as well as at the gateway so a
// directly exposed subgraph port is still protected (Issue #884).
const server = createSubgraphServiceServer({ typeDefs, resolvers });

// Start the server
const { url } = await startStandaloneServer(server, {
  context: async ({ req }) => {
    // Extract authentication information
    const apiKey = req.headers['x-api-key'] || null;
    const isAdmin = apiKey === process.env.ADMIN_API_KEY;
    
    return {
      isAdmin,
      apiKey,
      requestId: req.headers['x-request-id'] || 'unknown'
    };
  },
  listen: { port: PORT }
});

console.log(`🚀 Users Service ready at ${url}`);
console.log(`👤 Federated schema with @key directive on User.entity`);
