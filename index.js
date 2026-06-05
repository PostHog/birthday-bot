const { App } = require('@slack/bolt');
require('dotenv').config();
const registerCommands = require('./commands');
const registerApiRoutes = require('./api');
const { setupCronJobs } = require('./birthday-cron');
const express = require('express');


const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// Create an Express app to satisfy Render's port binding requirement
const expressApp = express();

// Add a simple health check endpoint
expressApp.get('/', (req, res) => {
  res.send('Birthday Bot is running!');
});

// Register commands, the webhook API, and setup cron jobs
registerCommands(app);
registerApiRoutes(expressApp, app.client);
setupCronJobs(app);

// Start both the Socket Mode app and the Express server
(async () => {
  // Start the Bolt app (Socket Mode)
  await app.start();
  console.log('⚡️ Birthday Bot Socket Mode started!');
  
  // Start Express server to satisfy Render
  const port = process.env.PORT || 10000;
  expressApp.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Express server is running on port ${port}`);
  });
})();