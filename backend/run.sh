#!/bin/bash
# WSD-Pro backend launcher
# Restart-proof: keeps the Node server alive with auto-restart
cd /home/ahmedali/wsd-pro/backend
export PATH="$PATH:/usr/local/bin:/usr/bin:/bin"

# Wait for docker socket if not ready
for i in $(seq 1 15); do
  [ -S /var/run/docker.sock ] && break
  sleep 1
done

exec node dist/index.js
