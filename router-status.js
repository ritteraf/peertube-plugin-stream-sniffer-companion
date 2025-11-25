const express = require('express');
const router = express.Router();
const { readJson, writeJson, requireAuth } = require('./lib-auth-manager.js');

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
	const statusLog = readJson('status');
	statusLog[snifferId] = {
		...statusData,
		lastUpdate: new Date().toISOString()
	};
	writeJson('status', statusLog);
	return res.status(200).json({
		acknowledged: true
	});
});

module.exports = router;
