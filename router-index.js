

// Export a function that wires up all routers after dependencies are injected
module.exports = function createPluginRouter({ storageManager, settingsManager, peertubeHelpers }) {
  const express = require('express');
  const router = express.Router();

  // Parse JSON bodies for all requests
  router.use(express.json());

  // Log all requests for debugging
  router.use((req, res, next) => {
    console.log(`[PLUGIN] ${req.method} ${req.originalUrl}`);
    next();
  });

  // Require routers and inject dependencies
  const createRouterAuth = require('./router-auth.js');
  router.use('/auth', createRouterAuth({ storageManager, settingsManager, peertubeHelpers }));

  const createRouterConfig = require('./router-config.js');
  router.use('/', createRouterConfig({ storageManager, settingsManager, peertubeHelpers }));

  const createRouterRecording = require('./router-recording.js');
  router.use('/recording', createRouterRecording({ storageManager, settingsManager, peertubeHelpers }));

  const createRouterHudl = require('./router-hudl.js');
  router.use('/hudl', createRouterHudl({ storageManager, settingsManager, peertubeHelpers }));

  const createRouterStatus = require('./router-status.js');
  router.use('/status', createRouterStatus({ storageManager, settingsManager, peertubeHelpers }));

  const createRouterError = require('./router-error.js');
  router.use('/error', createRouterError({ storageManager, settingsManager, peertubeHelpers }));

  // Global error handler for plugin routes
  router.use((err, req, res, next) => {
    console.error('[PLUGIN ERROR]', err);
    res.status(500).json({ error: 'PLUGIN_CRASH', message: err && err.message ? err.message : 'Unknown error', stack: err && err.stack });
  });

  return router;
};
