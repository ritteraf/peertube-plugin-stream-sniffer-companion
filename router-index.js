// Aggregates all routers for plugin endpoints
const express = require('express');
const router = express.Router();


// Parse JSON bodies for all requests
router.use(express.json());

// Log all requests for debugging
router.use((req, res, next) => {
	console.log(`[PLUGIN] ${req.method} ${req.originalUrl}`);
	next();
});

router.use('/auth', require('./router-auth.js'));
router.use('/config', require('./router-config.js'));
router.use('/recording', require('./router-recording.js'));
router.use('/hudl', require('./router-hudl.js'));
router.use('/status', require('./router-status.js'));
router.use('/error', require('./router-error.js'));

// Global error handler for plugin routes
router.use((err, req, res, next) => {
	console.error('[PLUGIN ERROR]', err);
	res.status(500).json({ error: 'PLUGIN_CRASH', message: err && err.message ? err.message : 'Unknown error', stack: err && err.stack });
});

module.exports = router;
