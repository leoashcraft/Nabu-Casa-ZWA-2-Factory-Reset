#!/usr/bin/with-contenv bashio
# with-contenv restores the container environment (incl. SUPERVISOR_TOKEN,
# which s6-overlay stashes away) before we hand off to the Node server.
exec node /app/server.mjs
