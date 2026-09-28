#!/bin/bash
# Wrapper: pulls the Claude OAuth token from the Vellum credential store at start, never on disk.
export PATH="/home/vellum/.bun/bin:/home/vellum/.local/bin:/usr/local/bin:/usr/bin:/bin"
export VELLUM_WORKSPACE_DIR=/home/vellum/.local/share/vellum/assistants/<name>/.vellum/workspace
export VELLUM_DATA_DIR=/home/vellum/.local/share/vellum/assistants/<name>/.vellum/workspace/data
export VELLUM_CLOUD=local VELLUM_ENVIRONMENT=local
export CLAUDE_CODE_OAUTH_TOKEN="$(assistant credentials reveal --service acp --field claude_oauth_token)"
exec bun run /home/vellum/claude-shim/server.js
