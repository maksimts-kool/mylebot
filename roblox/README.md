# Roblox package — no Rojo required

All Roblox source files and a one-step Studio installer are contained in this directory.

## Install into a place

1. Open the destination place in Roblox Studio.
2. Enable **Game Settings → Security → Allow HTTP Requests**.
3. Open **View → Command Bar**.
4. Open `Install.lua`, copy the entire file, paste it into the Studio Command Bar, and press Enter.
5. In Explorer, open `ServerScriptService → SessionTrackerConfig` and fill in the ingestion URL, secret, group ID, and rank range.
6. Save or publish the place.

The installer creates the following instances automatically:

```text
ServerScriptService
├── SessionTrackerConfig (ModuleScript, server-only)
└── SessionTracker       (Script)

StarterPlayer
└── StarterPlayerScripts
    └── SessionTracker   (LocalScript)
```

Run the same `Install.lua` in every place in the universe. Re-running it updates the server and client scripts but deliberately preserves the existing `SessionTrackerConfig`, so it will not overwrite a configured secret. Place authorization is enforced only by the backend's `ROBLOX_ALLOWED_PLACE_IDS` setting.

## Updating the generated installer

After changing any Roblox source file, regenerate `Install.lua` from the repository root:

```powershell
npm run roblox:installer
```

`SessionTrackerConfig.lua` is a local, gitignored configuration file. The generated installer uses `SessionTrackerConfig.example.lua`, so real secrets are never embedded in `Install.lua`.
