// Auth manager
// Helper for reading/writing JSON storage files and token management

const crypto = require('crypto');

// PeerTube will inject storageManager
let storageManager = null;
function setStorageManager(sm) { storageManager = sm; }

// Token generation (UUID v4)
function generateToken() {
	return crypto.randomUUID ? crypto.randomUUID() : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
		(c ^ crypto.randomBytes(1)[0] & 15 >> c / 4).toString(16)
	);
}

// Store and validate X-Stream-Token for sniffers (async)
async function saveSnifferToken(snifferId, token, expiresAt) {
	if (!storageManager) throw new Error('storageManager not initialized');
	let sniffers = (await storageManager.getData('sniffers')) || {};
	if (!sniffers[snifferId]) sniffers[snifferId] = {};
	sniffers[snifferId].streamToken = token;
	sniffers[snifferId].tokenExpiresAt = expiresAt;
	await storageManager.storeData('sniffers', sniffers);
}

async function validateToken(token) {
	if (!storageManager) throw new Error('storageManager not initialized');
	const sniffers = (await storageManager.getData('sniffers')) || {};
	for (const snifferId in sniffers) {
		const entry = sniffers[snifferId];
		if (entry.streamToken === token) {
			if (new Date(entry.tokenExpiresAt) > new Date()) {
				return { valid: true, snifferId };
			} else {
				return { valid: false, reason: 'expired', snifferId };
			}
		}
	}
	return { valid: false, reason: 'not_found' };
}

// Express middleware for endpoints requiring X-Stream-Token (async)
function requireAuth(req, res, next) {
	const token = req.header('X-Stream-Token');
	if (!token) {
		console.warn('[PLUGIN AUTH] Missing X-Stream-Token header');
		return res.status(401).json({
			error: 'REAUTH_REQUIRED',
			message: 'Authentication token missing',
			hint: 'Call /auth to get a new token'
		});
	}
	validateToken(token).then(result => {
		if (!result.valid) {
			console.warn('[PLUGIN AUTH] Invalid or expired token:', token, 'Reason:', result.reason);
			return res.status(401).json({
				error: 'REAUTH_REQUIRED',
				message: result.reason === 'expired' ? 'Authentication token expired' : 'Invalid token',
				hint: 'Call /auth to get a new token'
			});
		}
		req.snifferId = result.snifferId;
		next();
	}).catch(err => {
		console.error('[PLUGIN AUTH] Error validating token:', err);
		return res.status(500).json({ error: 'PLUGIN_AUTH_ERROR', message: err.message });
	});
}

module.exports = {
	setStorageManager,
	generateToken,
	saveSnifferToken,
	validateToken,
	requireAuth
};
