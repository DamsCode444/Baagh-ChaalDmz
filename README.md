# Baagh-Chaal

A 5×5 Nepali strategy game with local two-player play, a computer opponent, and persistent online rooms.

## Run

Install Node.js 22.18 or later, then run from this directory:

```sh
npm install
npm start
```

Open **http://localhost:3000**. Online play requires the Node server; local and computer modes can still run without a network connection.

Your existing `.env` names `turbo_db_url` and `turbo_db_token` are supported. Standard `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` names also work. Credentials are read only by the server, ignored by Git, and never sent to browsers. See `.env.example` for optional settings. Without a database URL, the server uses `.data/baagh-chaal.db` locally. `DATABASE_URL` overrides the Turso URL, which is useful for local development.

```sh
npm run db:check
npm test
npm run dev
```

`db:check` verifies the database connection and creates missing application tables. Tests use isolated local databases and never use your `.env` or write test matches to Turso.

Remote database requests honor `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` (also their lowercase forms). On Windows, an enabled manual system proxy is detected automatically if no environment proxy is set. This supports connections that work in your browser but otherwise time out in Node. PAC scripts are not evaluated; use `DATABASE_PROXY_URL=http://127.0.0.1:7877` for an explicit proxy, replacing the address with your own. `DATABASE_PROXY_URL=direct` disables all database proxy routing. `DATABASE_USE_SYSTEM_PROXY=false` disables only Windows proxy detection. Local SQLite does not use a proxy. Proxy routing applies only to database traffic.

If startup reports a network failure, check that your proxy is running and run `npm run db:check`. If it reports an occupied port, close the other game server or set `PORT=3001` in `.env`, then open `http://localhost:3001`.

## Play with a friend

1. Choose **Online multiplayer** and optionally enter your name.
2. Choose your side and click **Create room**.
3. Copy the invite link or share the eight-character code.
4. Your friend opens the link and clicks **Join**, or enters the code in online mode.
5. Goats go first. The server accepts moves only from the current side's player.

The same browser can use two separate tabs to play both sides: seat credentials live in each tab's `sessionStorage`. Refreshing a tab resumes its seat. Opening a second window with the same saved seat replaces its previous connection.

Undo is available only in local modes. Resigning, leaving an active room, or switching to a local mode gives the opponent the win. After a match, both players can request a rematch; a new game starts with their sides swapped.

Unexpected disconnections pause play for `RECONNECT_GRACE_MS` (90 seconds by default). A connected opponent wins when that window expires. If both players are offline when an expired deadline is processed, the game ends as an abandoned draw. Saved rooms expire after `ROOM_TTL_MS` of inactivity (24 hours by default); their associated move and match records are removed on expiry. Server restarts restore unexpired rooms and reserve active seats for reconnection.

For two devices on the same Wi-Fi, use the host computer's LAN address, for example `http://192.168.1.20:3000`. Both devices must be able to reach that server and the host's firewall must allow the selected port. Public internet play needs a deployed backend URL reachable by both players.

## Database and architecture

The server creates only these prefixed tables:

- `baagh_chaal_rooms`: private seats, hashed resume tokens, complete game snapshots, versions and expiry.
- `baagh_chaal_moves`: canonical actions and durable request acknowledgements for deduplication.
- `baagh_chaal_matches`: started matches, current/final state and results.

Each room operation is serialized. A database transaction commits the room update, accepted move and match record together before any broadcast. Updates check the previously stored version. Duplicate move IDs return the original acknowledgement; reusing an ID for a different action is rejected. Browsers never choose captures, winners or player identity.

Move saves use one atomic database batch rather than several sequential network requests. New moves at the current version skip the extra receipt lookup; recent acknowledgements are cached in a bounded server cache, and older retries use the durable records. The browser immediately previews a legal move while confirmation is pending. It cannot send another move until confirmation, and rejected moves or disconnections restore the confirmed board. Opponents receive only committed moves; wins and draws remain server decisions.

```text
js/rules.js       Shared rules and validated real moves
js/ai.js          Computer search with branch repetition tracking
js/controller.js Local match and undo history
js/multiplayer.js Socket connection, commands and tab-specific seat recovery
js/ui.js          Board, input, animations and local/online status
server/app.cjs    HTTP routes and Socket.IO event handlers
server/rooms.cjs  Room lifecycle and authoritative game actions
server/store.cjs  Turso/libSQL persistence and transactions
```

Socket events: `room:create`, `room:join`, `room:resume`, `room:sync`, `room:leave`, `game:move`, `game:resign`, and `game:rematch`. Requests receive `{ ok, error?, room? }` acknowledgements. Accepted snapshots arrive through `room:state`. Creation/join responses privately include seat credentials; public snapshots omit credentials, socket IDs and repetition history.

## Deploy

Run **one persistent Node process** with `npm start` on a host supporting WebSocket connections. Set the database credentials through the host's environment settings, use HTTPS, and set `PORT` as required. If a reverse proxy changes the upstream Host header, set `ALLOWED_ORIGINS` to the exact public origin, for example `https://game.example.com`. The frontend and socket backend are served from the same origin. Database initialization must succeed before the server begins listening.

This implementation owns live rooms in one process. Multiple instances require a shared Socket.IO adapter plus shared ownership/presence coordination; database persistence alone does not provide cross-instance broadcasting. Guest seats are private bearer credentials rather than registered accounts. Closing a tab removes its tab-specific credentials; refreshing preserves them.

Useful references: [Socket.IO rooms](https://socket.io/docs/v4/rooms/), [delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/), [Turso JavaScript SDK](https://docs.turso.tech/sdk/ts/reference).
