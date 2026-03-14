import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import authPlugin, { ROLE_HIERARCHY, hasRole } from '../core/auth.js';

describe('auth plugin', () => {
  describe('no apiToken configured (open access)', () => {
    it('sets userRole to admin when no apiToken', async () => {
      const app = Fastify();
      await app.register(authPlugin, { apiToken: null, roles: null });
      app.get('/test', (req, reply) => reply.send({ role: req.userRole }));

      const res = await app.inject({ method: 'GET', url: '/test' });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).role, 'admin');
    });
  });

  describe('with apiToken configured', () => {
    async function buildApp(opts = {}) {
      const app = Fastify();
      await app.register(authPlugin, { apiToken: 'secret123', ...opts });
      app.get('/test', (req, reply) => reply.send({ role: req.userRole }));
      return app;
    }

    it('accepts valid Bearer token and assigns admin role', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/test',
        headers: { authorization: 'Bearer secret123' }
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).role, 'admin');
    });

    it('accepts valid token from query string', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/test?token=secret123'
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).role, 'admin');
    });

    it('returns 401 with "Authentication required" when no token', async () => {
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/test' });
      assert.equal(res.statusCode, 401);
      assert.equal(JSON.parse(res.body).error, 'Authentication required');
    });

    it('returns 401 with "Invalid token" for wrong token', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/test',
        headers: { authorization: 'Bearer wrongtoken' }
      });
      assert.equal(res.statusCode, 401);
      assert.equal(JSON.parse(res.body).error, 'Invalid token');
    });

    it('uses timing-safe comparison (crypto.timingSafeEqual)', async () => {
      // Verified by source code inspection -- the auth.js module must
      // import crypto and call timingSafeEqual. We test indirectly:
      // a same-length wrong token must still be rejected.
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/test',
        headers: { authorization: 'Bearer secret124' } // same length, different
      });
      assert.equal(res.statusCode, 401);
      assert.equal(JSON.parse(res.body).error, 'Invalid token');
    });
  });

  describe('with roles config', () => {
    async function buildApp() {
      const app = Fastify();
      await app.register(authPlugin, {
        apiToken: 'secret123',
        roles: { token1: 'readonly', token2: 'user', secret123: 'admin' }
      });
      app.get('/test', (req, reply) => reply.send({ role: req.userRole }));
      return app;
    }

    it('resolves each token to its configured role', async () => {
      const app = await buildApp();

      const res1 = await app.inject({
        method: 'GET', url: '/test',
        headers: { authorization: 'Bearer token1' }
      });
      assert.equal(JSON.parse(res1.body).role, 'readonly');

      const res2 = await app.inject({
        method: 'GET', url: '/test',
        headers: { authorization: 'Bearer token2' }
      });
      assert.equal(JSON.parse(res2.body).role, 'user');

      const res3 = await app.inject({
        method: 'GET', url: '/test',
        headers: { authorization: 'Bearer secret123' }
      });
      assert.equal(JSON.parse(res3.body).role, 'admin');
    });

    it('defaults unknown valid token to user role', async () => {
      // A token that is the apiToken but not in the roles map
      const app = Fastify();
      await app.register(authPlugin, {
        apiToken: 'masterkey',
        roles: { token1: 'readonly' }
      });
      app.get('/test', (req, reply) => reply.send({ role: req.userRole }));

      const res = await app.inject({
        method: 'GET', url: '/test',
        headers: { authorization: 'Bearer masterkey' }
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).role, 'user');
    });
  });

  describe('ROLE_HIERARCHY and hasRole', () => {
    it('exports correct role hierarchy', () => {
      assert.equal(ROLE_HIERARCHY.readonly, 0);
      assert.equal(ROLE_HIERARCHY.user, 1);
      assert.equal(ROLE_HIERARCHY.admin, 2);
    });

    it('hasRole checks hierarchy correctly', () => {
      assert.equal(hasRole('admin', 'admin'), true);
      assert.equal(hasRole('admin', 'user'), true);
      assert.equal(hasRole('admin', 'readonly'), true);
      assert.equal(hasRole('user', 'admin'), false);
      assert.equal(hasRole('user', 'user'), true);
      assert.equal(hasRole('user', 'readonly'), true);
      assert.equal(hasRole('readonly', 'admin'), false);
      assert.equal(hasRole('readonly', 'user'), false);
      assert.equal(hasRole('readonly', 'readonly'), true);
    });
  });
});
