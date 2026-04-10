// ecosystem.config.js — PM2 process definitions
// Last audited: 2026-04-10. Removed entries for scripts that no longer exist:
//   builder-discord-bot/index.js      (repo deleted)
//   reviewer-discord-bot/index.js     (repo deleted)
//   ops-director-discord-bot/peter-telegram-bridge.js (file removed)
// image-gen: OPENAI_API_KEY must be set in environment before starting.

module.exports = {
  apps: [

    {
      name: 'commercial-director',
      script: '/Users/robotmac/workspace/commercial-director-discord-bot/index.js',
    },

    {
      name: 'ops-director',
      script: '/Users/robotmac/workspace/ops-director-discord-bot/index.js',
      cwd:    '/Users/robotmac/workspace/ops-director-discord-bot',
    },

    {
      name: 'designer',
      script: '/Users/robotmac/workspace/designer-discord-bot/index.js',
    },

    {
      // Requires OPENAI_API_KEY in environment (key no longer hardcoded in script)
      name:   'image-gen',
      script: '/Users/robotmac/workspace/image-gen-server.js',
    },

  ],
};
