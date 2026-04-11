#!/bin/bash
export $(cat /Users/robotmac/workspace/peter-heartbeat/.env | xargs)
exec node /Users/robotmac/workspace/peter-heartbeat/listener.js
