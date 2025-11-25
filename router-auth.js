// Auth endpoints
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');



// PeerTube will inject settingsManager into the router via setSettingsManager
let settingsManager = null;
function setSettingsManager(sm) { settingsManager = sm; }
async function getPluginSettings() {
  if (settingsManager) {
    return {
      'sniffer-auth-secret': await settingsManager.getSetting('sniffer-auth-secret'),
      'hudl-org-url': await settingsManager.getSetting('hudl-org-url'),
      'schedule-cache-minutes': await settingsManager.getSetting('schedule-cache-minutes')
    };
  }
  // Fallback for dev/test only
  return {
    'sniffer-auth-secret': process.env.SNIFFER_AUTH_SECRET || '',
    'hudl-org-url': process.env.HUDL_ORG_URL || '',
    'schedule-cache-minutes': 60
  };
}


// Auth helpers
const {
	generateToken,
	saveSnifferToken,
	readJson,
	writeJson
} = require('./lib-auth-manager.js');




// PeerTube helpers injected by main.js
let peertubeHelpers = null;
function setPeertubeHelpers(helpers) { peertubeHelpers = helpers; }

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

	// Register sniffer in storage
	const sniffers = readJson('sniffers');
	sniffers[snifferId] = {
		snifferId,
		streamToken: token,
		tokenExpiresAt: expiresAt,
		peertubeUsername: username,
		peertubePassword: password, // Store for later PeerTube API calls
		lastSeen: new Date(now).toISOString(),
		systemInfo: systemInfo || {}
	};
	writeJson('sniffers', sniffers);

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
});

router.setSettingsManager = setSettingsManager;
router.setPeertubeHelpers = setPeertubeHelpers;
module.exports = router;
