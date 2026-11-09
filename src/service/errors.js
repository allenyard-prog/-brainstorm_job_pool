export class ServiceError extends Error {
  constructor(statusCode, code, message, details) { super(message); Object.assign(this, { statusCode, code, details }); }
}
export const notFound = () => new ServiceError(404, 'NOT_FOUND', 'Resource not found.');
