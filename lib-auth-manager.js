// Auth manager
// Helper for reading/writing JSON storage files and token management

const crypto = require('crypto');
const { readJson, writeJson } = require('./lib/secure-store.js');

// Token generation (UUID v4)
function generateToken() {
	return crypto.randomUUID ? crypto.randomUUID() : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
		(c ^ crypto.randomBytes(1)[0] & 15 >> c / 4).toString(16)
	);
}

// Store and validate X-Stream-Token for sniffers
function saveSnifferToken(snifferId, token, expiresAt) {
	const sniffers = readJson('sniffers');
	if (!sniffers[snifferId]) sniffers[snifferId] = {};
	sniffers[snifferId].streamToken = token;
	sniffers[snifferId].tokenExpiresAt = expiresAt;
	writeJson('sniffers', sniffers);
}

function validateToken(token) {
	const sniffers = readJson('sniffers');
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

// Express middleware for endpoints requiring X-Stream-Token
function requireAuth(req, res, next) {
	const token = req.header('X-Stream-Token');
	if (!token) return res.status(401).json({ error: 'REAUTH_REQUIRED', message: 'Authentication token missing' });
	const result = validateToken(token);
	if (!result.valid) {
		return res.status(401).json({ error: 'REAUTH_REQUIRED', message: result.reason === 'expired' ? 'Authentication token expired' : 'Invalid token' });
	}
	req.snifferId = result.snifferId;
	next();
}

module.exports = {
	readJson,
	writeJson,
	generateToken,
	saveSnifferToken,
	validateToken,
	requireAuth
};
