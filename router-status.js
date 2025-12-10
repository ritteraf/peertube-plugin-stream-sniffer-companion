
// Export a factory function for dependency injection
module.exports = function createStatusRouter({ storageManager, settingsManager, peertubeHelpers }) {
       const express = require('express');
       const router = express.Router();
       const { requireAuth } = require('./lib-auth-manager.js');

       // Helper function to calculate staleness
       function calculateStaleInfo(lastUpdateIso) {
              if (!lastUpdateIso) return { isStale: true, staleSinceSeconds: null };
              const lastUpdate = new Date(lastUpdateIso).getTime();
              const now = Date.now();
              const secondsSinceUpdate = Math.floor((now - lastUpdate) / 1000);
              const isStale = secondsSinceUpdate > 600; // 10 minutes
              return {
                     isStale,
                     staleSinceSeconds: isStale ? secondsSinceUpdate : null
              };
       }

       // Helper function to sanitize sniffer status for public response
       function sanitizeSnifferStatus(snifferId, statusData) {
              const staleInfo = calculateStaleInfo(statusData.lastUpdate);
              return {
                     snifferId,
                     health: statusData.health || 'offline',
                     uptimeSeconds: statusData.uptimeSeconds || 0,
                     memoryGrowthRate: statusData.memoryGrowthRate || 0,
                     totalRecoveryAttempts: statusData.totalRecoveryAttempts || 0,
                     lastRestartTime: statusData.lastRestartTime || null,
                     lastRestartReason: statusData.lastRestartReason || null,
                     activeFailures: statusData.activeFailures || [],
                     activeStreams: statusData.activeStreams || [],
                     systemMetrics: statusData.systemMetrics || { cpuUsage: 0, memoryUsage: 0, diskSpace: 0 },
                     lastActivity: statusData.lastActivity || null,
                     lastUpdateTimestamp: statusData.lastUpdate || null,
                     isStale: staleInfo.isStale,
                     staleSinceSeconds: staleInfo.staleSinceSeconds
              };
       }

       // POST /status (authenticated - sniffers report status here)
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

       // GET /status (public - returns all sniffer statuses)
       router.get('/', async (req, res) => {
              try {
                     if (!storageManager) return res.status(500).json({ error: 'PLUGIN_STORAGE_NOT_INITIALIZED' });
                     
                     const statusLog = (await storageManager.getData('status')) || {};
                     const snifferIds = Object.keys(statusLog);
                     const sniffers = snifferIds.map(id => sanitizeSnifferStatus(id, statusLog[id]));
                     
                     // Calculate aggregate stats
                     const totalSniffers = sniffers.length;
                     const activeSniffers = sniffers.filter(s => !s.isStale).length;
                     const streamingSniffers = sniffers.filter(s => 
                            !s.isStale && s.activeStreams && s.activeStreams.some(stream => stream.status === 'streaming')
                     ).length;
                     
                     const pluginVersion = require('./package.json').version;
                     
                     return res.status(200).json({
                            timestamp: new Date().toISOString(),
                            pluginVersion,
                            totalSniffers,
                            activeSniffers,
                            streamingSniffers,
                            sniffers
                     });
              } catch (err) {
                     console.error('[PLUGIN STATUS] Error fetching status:', err);
                     return res.status(500).json({ error: 'Failed to fetch status', message: err.message });
              }
       });

       // GET /status/:snifferId (public - returns specific sniffer status)
       router.get('/:snifferId', async (req, res) => {
              try {
                     const { snifferId } = req.params;
                     if (!snifferId) {
                            return res.status(400).json({ error: 'snifferId is required' });
                     }
                     
                     if (!storageManager) return res.status(500).json({ error: 'PLUGIN_STORAGE_NOT_INITIALIZED' });
                     
                     const statusLog = (await storageManager.getData('status')) || {};
                     const statusData = statusLog[snifferId];
                     
                     if (!statusData) {
                            return res.status(404).json({ error: 'Sniffer not found', snifferId });
                     }
                     
                     const sanitized = sanitizeSnifferStatus(snifferId, statusData);
                     return res.status(200).json(sanitized);
              } catch (err) {
                     console.error('[PLUGIN STATUS] Error fetching sniffer status:', err);
                     return res.status(500).json({ error: 'Failed to fetch sniffer status', message: err.message });
              }
       });

       return router;
};
