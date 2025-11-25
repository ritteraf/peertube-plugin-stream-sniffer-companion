

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
    console.log('[PLUGIN main.js] About to require router-config.js and inject peertubeHelpers');
    const routerConfig = require('./router-config.js');
    if (routerConfig.setPeertubeHelpers) {
      routerConfig.setPeertubeHelpers(peertubeHelpers);
    }
  } catch (e) {
    console.error('[PLUGIN] Failed to wire peertubeHelpers to router-config:', e);
  }
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
    description: "Secret key for authenticating Stream Sniffer apps. Generate a secure random value (32+ characters). Copy/Paste this value during setup the of your stream sniffer(s). This will allow your sniffer(s) to communicate with PeerTube.",
    default: ''
  });
  registerSetting({
    name: 'hudl-org-url',
    label: 'HUDL Organization URL',
    type: 'input',
    required: false,
    description: "This is your HUDL 'fan' page. You can find this by searching for your school at fan.hudl.com"
  });
  registerSetting({
    name: 'schedule-cache-minutes',
    label: 'HUDL Schedule refresh interval (minutes)',
    type: 'input',
    required: false,
    description: 'This value will control how often the plugin will check HUDL for updates to your team schedules. You can always manually refresh the team schedules inside your sniffer app.',
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
