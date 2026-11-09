const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const object = properties => ({ type: 'object', additionalProperties: false, properties });
export const user = object({ id: { type: 'string' }, email: { type: 'string' }, role: { type: 'string' }, createdAt: { type: 'string' } });
export const connection = object({ id: { type: 'string' }, site: { type: 'string' }, label: { type: 'string' }, authStatus: { type: 'string' }, createdAt: { type: 'string' }, updatedAt: { type: 'string' } });
export const run = object({ id: { type: 'string' }, connectionId: nullableString, site: { type: 'string' }, kind: { type: 'string' }, transport: { type: 'string' }, options: { type: 'object', additionalProperties: true }, status: { type: 'string' }, phase: nullableString, queuedAt: { type: 'string' }, startedAt: nullableString, endedAt: nullableString, heartbeatAt: nullableString, counters: { type: 'object', additionalProperties: { type: 'number' } }, error: { anyOf: [object({ code: { type: 'string' }, message: { type: 'string' } }), { type: 'null' }] }, forced: { type: 'boolean' }, parentRunId: nullableString });
export const job = object({ id: { type: 'integer' }, connectionId: nullableString, site: { type: 'string' }, sourceJobId: { type: 'string' }, url: { type: 'string' }, title: { type: 'string' }, company: nullableString, firstSeenAt: { type: 'string' }, lastScrapedAt: { type: 'string' }, assignedAt: nullableString, processingState: nullableString, websiteStatus: nullableString });
export const detail = object({ ...job.properties, details: { type: 'object', additionalProperties: true }, raw: {} });
export const error = object({ error: object({ code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object', additionalProperties: true } }) });
export const list = item => object({ items: { type: 'array', items: item }, nextCursor: nullableString });
export const response = (code, schema) => ({ [code]: schema, 400: error, 401: error, 403: error, 404: error, 409: error, 429: error, 500: error, 503: error });
export const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 100 } }, additionalProperties: false };
export const pagination = { cursor: { type: 'string', maxLength: 500 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } };
export const jobFilters = {
  site: { type: 'string', maxLength: 100 },
  connectionId: { type: 'string', maxLength: 100 },
  q: { type: 'string', maxLength: 200 },
  status: { type: 'string', enum: ['saved','mark_pending','mark_confirmed','assigned','available'] },
  collectedFrom: { type: 'string', format: 'date-time', maxLength: 40 },
  collectedTo: { type: 'string', format: 'date-time', maxLength: 40 },
};
export const credentials = { email: { type: 'string', format: 'email', maxLength: 320 }, password: { type: 'string', minLength: 1, maxLength: 1000 } };
