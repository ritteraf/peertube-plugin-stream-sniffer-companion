
// Export a factory function for dependency injection
module.exports = function createStatusRouter({ storageManager, settingsManager, peertubeHelpers }) {
       const express = require('express');
       const router = express.Router();
       const { requireAuth } = require('./lib-auth-manager.js');

       // POST /status
       router.post('/', requireAuth, async (req, res) => {
              const snifferId = req.snifferId;
              const statusData = req.body || {};
              if (!statusData || typeof statusData !== 'object' || Array.isArray(statusData)) {
                     return res.status(400).json({
                            acknowledged: false,
                            message: 'Request body must be an object',
                            error: 'Invalid input'
                     });
              }
              if (!storageManager) return res.status(500).json({ error: 'PLUGIN_STORAGE_NOT_INITIALIZED' });
              let statusLog = (await storageManager.getData('status')) || {};
              statusLog[snifferId] = {
                     ...statusData,
                     lastUpdate: new Date().toISOString()
              };
              await storageManager.storeData('status', statusLog);
              return res.status(200).json({
                     acknowledged: true
              });
       });

       return router;
};
