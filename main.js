

// Global process-level error handlers for debugging
process.on('uncaughtException', err => {
  console.error('[PLUGIN uncaughtException]', err);
});
process.on('unhandledRejection', err => {
  console.error('[PLUGIN unhandledRejection]', err);
});

const express = require('express');
const routerIndex = require('./router-index.js');

async function register({ getRouter, registerSetting, settingsManager, peertubeHelpers }) {
  // Wire settingsManager into router-auth
  const routerAuth = require('./router-auth.js');
  if (routerAuth.setSettingsManager) {
    routerAuth.setSettingsManager(settingsManager);
  }
  if (routerAuth.setPeertubeHelpers) {
    routerAuth.setPeertubeHelpers(peertubeHelpers);
  }

  // Wire peertubeHelpers into router-config.js
  try {
    const routerConfig = require('./router-config.js');
    if (routerConfig.setPeertubeHelpers) {
      routerConfig.setPeertubeHelpers(peertubeHelpers);
    }
  } catch (e) {}
  // Optionally, wire peertubeHelpers into other routers/modules as needed
  try {
    const routerRecording = require('./router-recording.js');
    if (routerRecording.setPeertubeHelpers) {
      routerRecording.setPeertubeHelpers(peertubeHelpers);
    }
  } catch (e) {}
  try {
    const permLiveMgr = require('./lib-permanent-live-manager.js');
    if (permLiveMgr.setPeertubeHelpers) {
      permLiveMgr.setPeertubeHelpers(peertubeHelpers);
    }
  } catch (e) {}

  // Use getRouter to mount all plugin routes
  const router = getRouter();

  // Add a /ping test route for debugging
  router.get('/ping', (req, res) => {
    res.json({ pong: true });
  });

  // Mount all routes under /router (as before)
  router.use('/', require('./router-index.js'));

  // Register plugin settings (minimal UI)
  registerSetting({
    name: 'sniffer-auth-secret',
    label: 'Sniffer Authentication Secret',
    type: 'input',
    required: true,
    description: 'Secret key for authenticating Stream Sniffer apps. Generate a secure random value (32+ characters).',
    default: ''
  });
  registerSetting({
    name: 'hudl-org-url',
    label: 'HUDL Organization URL',
    type: 'input',
    required: false,
    description: 'HUDL organization URL for automatic game schedule integration.'
  });
  registerSetting({
    name: 'schedule-cache-minutes',
    label: 'Schedule Cache Duration (minutes)',
    type: 'input',
    required: false,
    description: 'How long to cache HUDL schedules before refreshing (minutes)',
    default: 60
  });
}

async function unregister () {
  return
}

module.exports = {
  register,
  unregister
}
