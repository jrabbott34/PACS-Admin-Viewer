#!/bin/bash
# Double-click launcher for macOS (Finder) and Linux (run as ./launch.command).
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "Installing dependencies the first time this runs - this can take a minute..."
  npm install || {
    echo "npm install failed. Make sure Node.js is installed: https://nodejs.org"
    read -r -p "Press Enter to close..."
    exit 1
  }
fi

echo "Freeing port 5173 if a previous copy is still running..."
PID=$(lsof -ti :5173 2>/dev/null)
if [ -n "$PID" ]; then
  kill -9 $PID 2>/dev/null
fi

echo "Starting PACS Admin DICOM Viewer..."
echo "(Leave this window open while you use the viewer. Press Ctrl+C to stop it when you're done.)"
npm run dev -- --port 5173 --strictPort &
SERVER_PID=$!

sleep 3

if command -v open >/dev/null 2>&1; then
  open "http://localhost:5173/"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:5173/"
fi

wait $SERVER_PID
