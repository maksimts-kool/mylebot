# Roblox package

Copy these source files into each Roblox place.

## Install into a place

1. Enable **Game Settings → Security → Allow HTTP Requests**.
2. Create the hierarchy below in Explorer and copy each matching source file into it.
3. Fill in `ServerScriptService → SessionTracker → Config`.
4. Save or publish the place.

Create these instances manually:

```text
ServerScriptService
└── SessionTracker (Folder, server-only)
    ├── Config       (ModuleScript) ← server/Config.example.lua
    ├── MainModule   (ModuleScript) ← server/MainModule.lua
    └── Bootstrap    (Script)       ← server/Bootstrap.server.lua

StarterPlayer
└── StarterPlayerScripts
    └── SessionTracker   (LocalScript) ← SessionTracker.client.lua
```

`MainModule` owns the server code; `Bootstrap` starts it. Add this package to every place in the universe.

## Install the Adonis command log plugin

```text
Workspace
└── Adonis_Loader
    └── Config
        └── Plugins
            └── Server-CommandLogs (ModuleScript) ← adonis/Server-CommandLogs.lua
```

The plugin reads `ServerScriptService → SessionTracker → Config` for the ingestion URL and secret, so there is no second copy of the secret. Without that module it warns once and stays off.

It reports every command staff run to `POST /v1/roblox/commands/batch`, reports who is in the server to `POST /v1/roblox/commands/roster` every 60 seconds (and whenever somebody joins or leaves, and once more on shutdown), and polls `GET /v1/roblox/command-blocks` every 15 seconds for the people whose command access was taken away from Discord. The roster is what the server's Discord panel is drawn from. Blocks are enforced by wrapping `Process.Command` rather than through Adonis's own blacklist, because the blacklist is skipped for the place owner and for Creators — including whoever is testing in Studio.

Unlike the session tracker, this plugin does run in Studio, so the Discord side can be tested without publishing a place; the backend decides whether to keep Studio runs. Private and reserved servers are skipped here too.

Studio playtests and private servers (VIP or reserved) are never tracked — `MainModule` skips them, so those sessions are ignored entirely.

`server/Config.lua` is a local, gitignored configuration file. Copy `server/Config.example.lua` to it when maintaining a local configuration; never commit the secret.
