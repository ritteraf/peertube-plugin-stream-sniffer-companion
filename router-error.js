const express = require('express');
const router = express.Router();
const { readJson, writeJson, requireAuth } = require('./lib-auth-manager.js');

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
	const errorsLog = readJson('errors');
	if (!errorsLog[snifferId]) errorsLog[snifferId] = [];
	errorsLog[snifferId].push({
		...errorData,
		timestamp: new Date().toISOString()
	});
	writeJson('errors', errorsLog);
	return res.status(200).json({
		acknowledged: true,
		message: 'Error logged'
	});
});

module.exports = router;
