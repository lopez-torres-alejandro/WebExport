@echo off
cd /d "%~dp0"
set NODE_OPTIONS=--max-old-space-size=4096
start "" http://localhost:3000
node server.js