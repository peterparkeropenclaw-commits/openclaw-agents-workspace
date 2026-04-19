'use strict';

const path = require('path');

const cwd = __dirname;

module.exports = {
  apps: [
    {
      name: 'peter-heartbeat',
      cwd,
      script: path.join(cwd, 'index.js'),
      interpreter: 'node',
      env_file: path.join(cwd, '.env'),
      watch: false,
      autorestart: true,
      time: true,
    },
    {
      name: 'strclinic-listener',
      cwd,
      script: path.join(cwd, 'str-clinic-worker.js'),
      interpreter: 'node',
      env_file: path.join(cwd, '.env'),
      watch: false,
      autorestart: true,
      time: true,
    },
  ],
};
