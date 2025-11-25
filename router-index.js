// Aggregates all routers for plugin endpoints
const express = require('express');
const router = express.Router();

// Parse JSON bodies for all requests
router.use(express.json());

router.use('/auth', require('./router-auth.js'));
router.use('/config', require('./router-config.js'));
router.use('/recording', require('./router-recording.js'));
router.use('/hudl', require('./router-hudl.js'));
router.use('/status', require('./router-status.js'));
router.use('/error', require('./router-error.js'));

module.exports = router;
