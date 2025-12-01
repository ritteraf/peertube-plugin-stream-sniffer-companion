
// Export a factory function for dependency injection
module.exports = function createErrorRouter({ storageManager, settingsManager, peertubeHelpers }) {
       const express = require('express');
       const router = express.Router();
       const { requireAuth } = require('./lib-auth-manager.js');

       // POST /error
       router.post('/', requireAuth, async (req, res) => {
              const snifferId = req.snifferId;
              const errorData = req.body || {};
              if (!errorData || typeof errorData !== 'object' || Array.isArray(errorData) || !errorData.message || typeof errorData.message !== 'string') {
                     return res.status(400).json({
                            acknowledged: false,
                            message: 'Request body must be an object with message (string)',
                            error: 'Invalid input'
                     });
              }
              if (!storageManager) return res.status(500).json({ error: 'PLUGIN_STORAGE_NOT_INITIALIZED' });
              let errorsLog = (await storageManager.getData('errors')) || {};
              if (!errorsLog[snifferId]) errorsLog[snifferId] = [];
              errorsLog[snifferId].push({
                     ...errorData,
                     timestamp: new Date().toISOString()
              });
              await storageManager.storeData('errors', errorsLog);
              return res.status(200).json({
                     acknowledged: true,
                     message: 'Error logged'
              });
       });

       return router;
};
