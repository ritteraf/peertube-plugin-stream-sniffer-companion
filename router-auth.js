// Encryption helpers for credentials
const { encrypt, decrypt } = require('./lib/secure-store.js');

// Export a factory function for dependency injection
module.exports = function createAuthRouter({ storageManager, settingsManager, peertubeHelpers }) {
  const { encrypt, decrypt } = require('./lib/secure-store.js');
  const express = require('express');
  const router = express.Router();
  const fs = require('fs');
  const path = require('path');
  const { generateToken, saveSnifferToken } = require('./lib-auth-manager.js');

  async function getPluginSettings() {
    if (settingsManager) {
      const snifferAuthSecret = await settingsManager.getSetting('sniffer-auth-secret');
      const hudlOrgUrl = await settingsManager.getSetting('hudl-org-url');
      const scheduleCacheMinutes = await settingsManager.getSetting('schedule-cache-minutes');
      return {
        'sniffer-auth-secret': snifferAuthSecret,
        'hudl-org-url': hudlOrgUrl,
        'schedule-cache-minutes': scheduleCacheMinutes
      };
    }
    // Fallback for dev/test only
    return {
      'sniffer-auth-secret': process.env.SNIFFER_AUTH_SECRET || '',
      'hudl-org-url': process.env.HUDL_ORG_URL || '',
      'schedule-cache-minutes': 60
    };
  }

  // Async helpers for sniffer registrations (now using storageManager)
  async function getSnifferRegistry() {
    if (!storageManager) throw new Error('storageManager not initialized');
    const reg = (await storageManager.getData('sniffers')) || {};
    // Decrypt password fields if present
    for (const snifferId in reg) {
      if (reg[snifferId] && reg[snifferId].peertubePassword) {
        try {
          reg[snifferId].peertubePassword = decrypt(reg[snifferId].peertubePassword);
        } catch (e) {
          console.error('[PLUGIN] Failed to decrypt password for', snifferId, e);
          reg[snifferId].peertubePassword = null;
        }
      }
    }
    return reg;
  }
  async function setSnifferRegistry(registry) {
    if (!storageManager) throw new Error('storageManager not initialized');
    // Debug: log keys and type
    if (typeof registry !== 'object' || Array.isArray(registry) || registry === null) {
      console.error('[PLUGIN router-auth] setSnifferRegistry called with invalid type:', typeof registry, registry);
      throw new Error('Invalid sniffer registry type');
    }
    const keys = Object.keys(registry);
    // Defensive: check for known config keys that should NOT be present
    const forbidden = ['sniffer-auth-secret', 'hudl-org-url', 'schedule-cache-minutes', 'camera-assignments'];
    for (const key of forbidden) {
      if (registry.hasOwnProperty(key)) {
        console.error('[PLUGIN router-auth] setSnifferRegistry: registry contains forbidden key:', key, 'FULL OBJECT:', registry);
        throw new Error('Attempt to overwrite plugin settings with forbidden key: ' + key);
      }
    }
    await storageManager.storeData('sniffers', registry);
  }

  // POST /auth
  router.post('/', async (req, res) => {
    const settings = await getPluginSettings();
    const { snifferId, snifferSecret, username, password, version, capabilities, systemInfo } = req.body || {};

    if (!settings['sniffer-auth-secret']) {
      return res.status(400).json({
        error: 'PLUGIN_SETTING_MISSING',
        code: 'PLUGIN_SETTING_MISSING',
        message: 'Plugin authentication secret not configured',
        hint: "Administrator must set 'Sniffer Authentication Secret' in plugin settings"
      });
    }
    if (!snifferSecret || snifferSecret !== settings['sniffer-auth-secret']) {
      return res.status(400).json({
        error: 'INVALID_CREDENTIALS',
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid sniffer secret'
      });
    }
    if (!snifferId || !username || !password) {
      return res.status(400).json({
        error: 'INVALID_CREDENTIALS',
        code: 'INVALID_CREDENTIALS',
        message: 'Missing required fields'
      });
    }

    // Do NOT verify PeerTube credentials here. Just store for later API calls.
    const now = Date.now();
    const token = generateToken();
    const expiresAt = new Date(now + 3600 * 1000).toISOString();

    // Register sniffer in persistent settings ONLY if OAuth token is obtained
    try {
      const sniffers = await getSnifferRegistry();
      // Fetch OAuth token for the user
      let oauthToken = null;
      try {
        const { getPeerTubeToken } = require('./lib-peertube-api.js');
        oauthToken = await getPeerTubeToken({
          username,
          password,
          peertubeHelpers,
          settingsManager
        });
        if (oauthToken) {
          console.log(`[PLUGIN AUTH] Successfully fetched and stored OAuth token for sniffer ${snifferId}.`);
        } else {
          console.warn(`[PLUGIN AUTH] No OAuth token received for sniffer ${snifferId}.`);
        }
      } catch (e) {
        console.error('[PLUGIN AUTH] Failed to get PeerTube OAuth token for sniffer', snifferId, e.message);
        return res.status(401).json({
          error: 'INVALID_PEERTUBE_CREDENTIALS',
          message: 'Failed to authenticate with PeerTube: ' + e.message
        });
      }
      if (!oauthToken) {
        return res.status(401).json({
          error: 'INVALID_PEERTUBE_CREDENTIALS',
          message: 'No OAuth token received from PeerTube.'
        });
      }
      sniffers[snifferId] = {
        snifferId,
        streamToken: token,
        tokenExpiresAt: expiresAt,
        peertubeUsername: username,
        peertubePassword: encrypt(password), // Encrypt before storing
        oauthToken,
        lastSeen: new Date(now).toISOString(),
        systemInfo: systemInfo || {}
      };
      await setSnifferRegistry(sniffers);
      return res.status(200).json({
        token,
        expiresAt,
        authMethod: {
          header: 'X-Stream-Token',
          value: token,
          note: 'Include this header in all subsequent requests'
        },
        peertubeUser: username,
        config: {
          checkInterval: 30,
          statusReportInterval: 60
        }
      });
    } catch (err) {
      return res.status(500).json({ error: 'PLUGIN_SNIFFER_REGISTRATION_FAILED', message: err.message });
    }
  });

  return router;
};
			const now = Date.now();
