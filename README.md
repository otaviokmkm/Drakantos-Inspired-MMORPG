# Minimal Multiplayer 2D RPG (Top-Down)

This is a minimalist Node.js + Express + Socket.IO project with JWT auth and a canvas client. Players can register/login, then spawn into a blank map and move with WASD. Movement is synced across connected clients.

## Features
- Register/Login via REST (JWT)
- Authenticated Socket.IO connection
- In-memory users and players store (no DB)
- Top-down 2D blank map, simple circles for players
- WASD movement, 60 FPS client tick, server state broadcast

## Run
1. Install dependencies
2. Start the server
3. Open http://localhost:3000

## Notes
- For demo only. Memory stores reset on restart.
- Replace JWT secret in production.
