/**
 * Firebase Cloud Functions entry point (2nd gen).
 *
 * Firebase resolves this file from package.json "main" and looks for exported
 * functions here. Hosting rewrites every non-static request to `app`, which is
 * the same Express instance that `npm start` runs locally.
 */

const { onRequest } = require('firebase-functions/v2/https');
const app = require('./server');

exports.app = onRequest(
  {
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 60,
    // A cafe screen polls every 3s; a small ceiling keeps a runaway loop from
    // scaling out indefinitely.
    maxInstances: 10,
  },
  app
);
