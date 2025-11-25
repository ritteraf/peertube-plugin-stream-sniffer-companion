// Auth endpoints
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');


// Helper to get plugin settings, using PeerTube settingsManager if available
let settingsManagerInstance = null;
function setSettingsManager(sm) { settingsManagerInstance = sm; }
async function getPluginSettings() {
	if (settingsManagerInstance) {
		return {
			'sniffer-auth-secret': await settingsManagerInstance.get('sniffer-auth-secret'),
			'hudl-org-url': await settingsManagerInstance.get('hudl-org-url'),
			'schedule-cache-minutes': await settingsManagerInstance.get('schedule-cache-minutes')
		};
	}
	try {
		const settingsPath = path.join(__dirname, 'storage', 'settings.json');
		if (fs.existsSync(settingsPath)) {
			return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
		}
	} catch (e) {}
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


// PeerTube API for OAuth
const { authenticateWithPassword } = require('./lib-peertube-api.js');

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

	// PeerTube OAuth client credentials (should be set in env or config)
	const clientId = process.env.PEERTUBE_CLIENT_ID || settings['peertube-client-id'] || 'sniffer-client';
	const clientSecret = process.env.PEERTUBE_CLIENT_SECRET || settings['peertube-client-secret'] || 'sniffer-secret';

	let oauthAccessToken, oauthRefreshToken, accessTokenExpiresAt, refreshTokenExpiresAt;
	try {
		const oauth = await authenticateWithPassword({ username, password, clientId, clientSecret });
		oauthAccessToken = oauth.accessToken;
		oauthRefreshToken = oauth.refreshToken;
		accessTokenExpiresAt = oauth.expiresAt;
		// Assume refresh token expires in 14 days (PeerTube default)
		refreshTokenExpiresAt = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
	} catch (err) {
		return res.status(400).json({
			error: 'INVALID_CREDENTIALS',
			code: 'INVALID_CREDENTIALS',
			message: 'Invalid PeerTube username or password',
			hint: err.message
		});
	}

	const now = Date.now();
	const token = generateToken();
	const expiresAt = new Date(now + 3600 * 1000).toISOString();

	// Register sniffer in storage
	const sniffers = readJson('sniffers');
	sniffers[snifferId] = {
		snifferId,
		streamToken: token,
		tokenExpiresAt: expiresAt,
		oauthAccessToken,
		oauthRefreshToken,
		oauthExpiresAt: accessTokenExpiresAt,
		peertubeUsername: username,
		lastSeen: new Date(now).toISOString(),
		systemInfo: systemInfo || {}
	};
	writeJson('sniffers', sniffers);

	return res.status(200).json({
		token,
		expiresAt,
		accessTokenExpiresAt,
		refreshTokenExpiresAt,
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

module.exports = router;
module.exports.setSettingsManager = setSettingsManager;
