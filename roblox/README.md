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

Studio playtests and private servers (VIP or reserved) are never tracked — `MainModule` skips them, so those sessions are ignored entirely.

`server/Config.lua` is a local, gitignored configuration file. Copy `server/Config.example.lua` to it when maintaining a local configuration; never commit the secret.
