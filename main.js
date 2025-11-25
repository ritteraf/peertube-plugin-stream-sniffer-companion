
const express = require('express');
const routerIndex = require('./router-index.js');

async function register({ getRouter, registerSetting, settingsManager }) {
  // Wire settingsManager into router-auth
  const routerAuth = require('./router-auth.js');
  if (routerAuth.setSettingsManager) {
    routerAuth.setSettingsManager(settingsManager);
  }

  // Use getRouter to mount all plugin routes
  const router = getRouter();
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
