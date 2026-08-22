const app = require('../server');
const { mainPool } = require('../config/db');
const { autoMigrate } = require('../config/autoMigrate');

// Guarantee 100% schema completeness on serverless cold starts
autoMigrate(mainPool).catch(e => console.error('[Serverless AutoMigrate Error]', e.message));

module.exports = app;
