import { parentPort, workerData } from 'node:worker_threads';
import { ServiceStore, rpcMethods } from './service-store.js';
const store = new ServiceStore(workerData.path);
parentPort.on('message', ({ id, method, args }) => {
  try {
    if (!rpcMethods.includes(method)) throw new Error('Unknown database operation.');
    parentPort.postMessage({ id, result: store[method](...args) });
  } catch (error) { parentPort.postMessage({ id, error: { message: error.message, statusCode: error.statusCode, code: error.code, details: error.details } }); }
});
parentPort.postMessage({ ready: true });
