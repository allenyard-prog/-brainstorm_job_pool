import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import staticFiles from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { join, extname } from 'node:path';
import { unlink, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AsyncStore } from '../storage/async-store.js';
import { Supervisor } from './supervisor.js';
import { acquireLock } from '../core/lock.js';
import { loadPlugin, listSites } from '../core/plugin-registry.js';
import { accountKey } from '../core/security.js';
import { hashPassword, verifyPassword, hashToken, encryptCredentials, scrubSecrets } from './crypto.js';
import { ServiceError } from './errors.js';
import * as s from './schemas.js';
import { jobCsv, jobTsv } from './job-export.js';

const bodySchema = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const empty = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } };

export async function buildService(config, { supervise = true } = {}) {
  const release = await acquireLock(join(config.dataDir, 'service.lock'));
  const db = new AsyncStore(config.dbPath);
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024, ajv: { customOptions: { removeAdditional: false } } });
  const supervisor = new Supervisor(db, config);
  let closed = false;
  async function cleanup() {
    if (closed) return; closed = true;
    try { await supervisor.close(); } finally { try { await db.close(); } finally { await release(); } }
  }
  try {
    await db.ready;
    await app.register(cookie);
    await app.register(rateLimit, { global: false, hook: 'preHandler' });
    await app.register(swagger, { openapi: { info: { title: 'Job automation API', version: '1.0.0' }, components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'session' } } } } });
    await app.register(swaggerUi, { routePrefix: '/docs' });
    app.decorateRequest('user', null);
    app.decorate('db', db); app.decorate('supervisor', supervisor);
    app.setErrorHandler((error, request, reply) => {
      let status = error.statusCode ?? 500;
      if (status < 400 || status > 599) status = 500;
      const code = error.validation ? 'VALIDATION_ERROR' : error.code?.startsWith('ERR_SQLITE') ? 'DATABASE_ERROR' : error.code ?? 'INTERNAL_ERROR';
      const message = status >= 500 ? 'The service could not complete this request.' : error.validation ? 'Invalid request parameters.' : status === 429 ? 'Too many login attempts. Try again later.' : error.message;
      reply.code(status).send({ error: { code, message, ...(error.details && status < 500 ? { details: error.details } : {}) } });
    });
    app.addHook('preValidation', async request => {
      if (request.routeOptions.config.allowEmptyBody && request.body === undefined) request.body = {};
      if (!['GET','HEAD','OPTIONS'].includes(request.method) && !config.allowedOrigins.includes(request.headers.origin)) throw new ServiceError(403, 'INVALID_ORIGIN', 'Request origin is not allowed.');
    });
    app.addHook('preHandler', async request => {
      if (!request.url.startsWith('/api/v1/') || request.routeOptions.config.public) return;
      const token = request.cookies.session;
      const user = token && await db.call('sessionUser', hashToken(token));
      if (!user) throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to the backend.');
      request.user = user;
      if (request.routeOptions.config.admin && user.role !== 'admin') throw new ServiceError(403, 'FORBIDDEN', 'Administrator access is required.');
    });
    const route = (method, url, schema, handler, options = {}) => app.route({ method, url: `/api/v1${url}`, schema: { ...schema, security: options.public ? [] : [{ session: [] }] }, config: options, handler });
    const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: config.secureCookies, path: '/api/v1', maxAge: Math.floor(config.sessionMs / 1000) };

    route('POST', '/auth/login', { body: bodySchema({ email: s.credentials.email, password: { type: 'string', minLength: 1, maxLength: 256 } }, ['email','password']), response: s.response(200, s.user) }, async (request, reply) => {
      const user = await db.call('findUser', request.body.email);
      if (!await verifyPassword(request.body.password, user?.password_hash)) throw new ServiceError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
      const token = randomBytes(32).toString('base64url');
      await db.call('createSession', { tokenHash: hashToken(token), userId: user.id, expiresAt: Date.now() + config.sessionMs });
      reply.setCookie('session', token, cookieOptions);
      return { id: user.id, email: user.email, role: user.role, createdAt: user.created_at };
    }, { public: true, rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: request => `${request.ip}:${hashToken(String(request.body?.email ?? '').toLowerCase())}` } });
    route('POST', '/auth/logout', { response: s.response(200, empty) }, async (request, reply) => {
      await db.call('deleteSession', hashToken(request.cookies.session)); reply.clearCookie('session', cookieOptions); return { ok: true };
    });
    route('GET', '/auth/me', { response: s.response(200, s.user) }, request => request.user);
    route('GET', '/sites', { response: s.response(200, { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string' }, name: { type: 'string' }, transports: { type: 'array', items: { type: 'string' } }, operations: { type: 'array', items: { type: 'string' } },
    } } }) }, () => listSites(config.sites));
    route('POST', '/users', { body: bodySchema({ email: s.credentials.email, password: { type: 'string', minLength: 12, maxLength: 256 }, role: { type: 'string', enum: ['admin','user'], default: 'user' } }, ['email','password']), response: s.response(201, s.user) }, async (request, reply) => {
      const user = await db.call('createUser', { email: request.body.email, passwordHash: await hashPassword(request.body.password), role: request.body.role });
      return reply.code(201).send(user);
    }, { admin: true });
    route('GET', '/users', { response: s.response(200, { type: 'array', items: s.user }) }, () => db.call('listUsers'), { admin: true });
    route('POST', '/connections', { body: bodySchema({ site: { type: 'string', enum: config.sites ?? ['jobright'] }, ...s.credentials }, ['site','email','password']), response: s.response(201, s.connection) }, async (request, reply) => {
      await loadPlugin(request.body.site, 'browser');
      const key = accountKey(request.body.email);
      const result = await db.call('createConnection', { userId: request.user.id, site: request.body.site, accountKey: key, label: request.body.email,
        encryptedCredentials: encryptCredentials({ email: request.body.email, password: request.body.password }, config.key, `${request.user.id}:${request.body.site}:${key}`) });
      return reply.code(201).send(result);
    });
    route('GET', '/connections', { response: s.response(200, { type: 'array', items: s.connection }) }, request => db.call('listConnections', request.user.id));
    route('PATCH', '/connections/:id/credentials', { params: s.idParams, body: bodySchema(s.credentials, ['email','password']), response: s.response(200, s.connection) }, async request => {
      const connection = await db.call('getConnection', request.user.id, request.params.id);
      const key = accountKey(request.body.email);
      const updated = await db.call('updateCredentials', request.user.id, connection.id, { accountKey: key, label: request.body.email, encryptedCredentials: encryptCredentials(request.body, config.key, `${request.user.id}:${connection.site}:${key}`) });
      try { await unlink(join(config.dataDir, 'sessions', request.user.id, connection.id, 'session.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return updated;
    });
    route('POST', '/connections/:id/authenticate', { params: s.idParams, body: bodySchema({ headed: { type: 'boolean', default: false } }), response: s.response(202, s.run) }, async (request, reply) => {
      const run = await db.call('enqueue', request.user.id, request.params.id, 'authentication', { transport: 'browser', readOnly: true, limit: null, headed: request.body?.headed ?? false });
      return reply.code(202).send(run);
    }, { allowEmptyBody: true });
    route('POST', '/runs', { body: bodySchema({ connectionId: { type: 'string', minLength: 1 }, transport: { type: 'string', enum: ['browser','api'], default: 'browser' }, readOnly: { type: 'boolean', default: false }, limit: { anyOf: [{ type: 'integer', minimum: 1, maximum: 1000000 }, { type: 'null' }], default: null } }, ['connectionId']), response: s.response(202, s.run) }, async (request, reply) => {
      const connection = await db.call('getConnection', request.user.id, request.body.connectionId);
      const { transport, readOnly, limit } = request.body;
      await loadPlugin(connection.site, transport, { write: !readOnly });
      const run = await db.call('enqueue', request.user.id, connection.id, 'collection', { transport, readOnly, limit });
      return reply.code(202).send(run);
    });
    route('GET', '/runs', { querystring: bodySchema({ ...s.pagination, connectionId: { type: 'string', maxLength: 100 }, status: { type: 'string', enum: ['active','queued','starting','running','stop_requested','stopped','completed','failed','attention_required','interrupted'] } }), response: s.response(200, s.list(s.run)) }, request => db.call('listRuns', request.user.id, request.query));
    route('GET', '/runs/:id', { params: s.idParams, response: s.response(200, s.run) }, request => db.call('getRun', request.user.id, request.params.id));
    route('POST', '/runs/:id/stop', { params: s.idParams, response: s.response(202, s.run) }, async (request, reply) => {
      const run = await db.call('stopRun', request.user.id, request.params.id); supervisor.cancel(run.id); return reply.code(202).send(run);
    });
    route('POST', '/runs/:id/retry', { params: s.idParams, response: s.response(202, s.run) }, async (request, reply) => {
      const previous = await db.call('getRun', request.user.id, request.params.id);
      const run = await db.call('enqueue', request.user.id, previous.connectionId, previous.kind, previous.options, previous.id);
      return reply.code(202).send(run);
    });
    route('GET', '/runs/:id/events', { params: s.idParams, querystring: bodySchema({ after: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }), response: s.response(200, { type: 'object', additionalProperties: false, properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'integer' }, type: { type: 'string' }, payload: { type: 'object', additionalProperties: true }, createdAt: { type: 'string' } } } }, nextCursor: { type: 'integer' } } }) }, request => db.call('events', request.user.id, request.params.id, request.query));
    route('GET', '/jobs', { querystring: bodySchema({ ...s.pagination, ...s.jobFilters }), response: s.response(200, s.list(s.job)) }, request => db.call('listJobs', request.user.id, request.query));
    route('POST', '/jobs/assign', { body: bodySchema(s.jobFilters), response: s.response(200, bodySchema({ assignedCount: { type: 'integer', minimum: 0 } }, ['assignedCount'])) }, request => db.call('assignJobs', request.user.id, request.body));
    route('GET', '/jobs/clipboard', { querystring: bodySchema(s.jobFilters), response: s.response(200, { type: 'string' }) }, async (request, reply) => {
      const firstPage = await db.call('listJobs', request.user.id, { ...request.query, limit: 100 });
      return reply.type('text/plain; charset=utf-8').header('Cache-Control', 'private, no-store')
        .send(Readable.from(jobTsv(db, request.user.id, request.query, firstPage)));
    });
    route('GET', '/jobs/export', { querystring: bodySchema(s.jobFilters), response: s.response(200, { type: 'string' }) }, async (request, reply) => {
      const firstPage = await db.call('listJobs', request.user.id, { ...request.query, limit: 100, includeDetails: true });
      return reply.type('text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="gather-jobs.csv"')
        .header('Cache-Control', 'private, no-store')
        .send(Readable.from(jobCsv(db, request.user.id, request.query, firstPage)));
    });
    route('GET', '/jobs/:id', { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } }, querystring: bodySchema({ includeRaw: { type: 'boolean', default: false } }), response: s.response(200, s.detail) }, async request => scrubSecrets(await db.call('jobDetail', request.user.id, request.params.id, request.query.includeRaw)));
    app.get('/health', { schema: { response: { 200: empty } } }, async () => ({ ok: true }));
    app.get('/ready', { schema: { response: { 200: empty, 503: s.error } } }, async () => {
      let timeout;
      try { await Promise.race([db.call('ping'), new Promise((_, reject) => { timeout = setTimeout(() => reject(new ServiceError(503, 'NOT_READY', 'Database is unavailable.')), 500); })]); }
      catch { throw new ServiceError(503, 'NOT_READY', 'Database is unavailable.'); }
      finally { clearTimeout(timeout); }
      return { ok: true };
    });
    const webDist = config.webDist === null ? null : config.webDist ?? fileURLToPath(new URL('../../web/dist/', import.meta.url));
    let hasWeb = false;
    if (webDist) { try { await access(join(webDist, 'index.html')); hasWeb = true; } catch { /* API-only startup remains supported. */ } }
    if (hasWeb) await app.register(staticFiles, { root: webDist, prefix: '/', wildcard: false, index: false, decorateReply: false });
    app.setNotFoundHandler((request, reply) => {
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      const reserved = /^\/(api|docs|health|ready|assets)(\/|$)/.test(path);
      if (hasWeb && ['GET','HEAD'].includes(request.method) && !reserved && !extname(path)) {
        return reply.header('Cache-Control', 'no-cache').type('text/html').send(createReadStream(join(webDist, 'index.html')));
      }
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Resource not found.' } });
    });
    app.addHook('onClose', cleanup);
    await app.ready();
    if (supervise) await supervisor.start();
    return app;
  } catch (error) { await cleanup(); throw error; }
}
