--!nonstrict
--[[
	Server-CommandLogs

	Reports every Adonis command staff run to the bot, which posts it as an
	embed in a Discord thread named after this server, and enforces the
	fifteen-minute command blocks pressed from those embeds.

	Place this ModuleScript in Adonis_Loader > Config > Plugins and name it
	"Server-CommandLogs". Configuration is read from
	ServerScriptService.SessionTracker.Config, so the ingestion secret lives in
	one place per game.
--]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local ServerScriptService = game:GetService("ServerScriptService")

local CONFIG_WAIT_SECONDS = 30
local DEFAULT_FLUSH_SECONDS = 5
local DEFAULT_BLOCK_POLL_SECONDS = 15
local DEFAULT_MAXIMUM_PENDING = 200
local DEFAULT_RETRY_BASE_SECONDS = 2
local DEFAULT_RETRY_MAXIMUM_SECONDS = 60
local TARGET_LIMIT = 25

local function loadConfig()
	local folder = ServerScriptService:WaitForChild("SessionTracker", CONFIG_WAIT_SECONDS)
	local module = folder and folder:FindFirstChild("Config")
	if not module then
		warn("CommandLogs: ServerScriptService.SessionTracker.Config is missing; command logging is off")
		return nil
	end
	local ok, config = pcall(require, module)
	if not ok or type(config) ~= "table" then
		warn("CommandLogs: Config failed to load; command logging is off")
		return nil
	end
	if not config.IngestionBaseUrl or not config.IngestionSecret then
		warn("CommandLogs: Config has no IngestionBaseUrl or IngestionSecret; command logging is off")
		return nil
	end
	return config
end

return function(Vargs)
	local server = Vargs.Server
	local service = Vargs.Service

	-- Private and reserved servers are never read, in Studio or out of it. A
	-- Studio playtest is logged so the plugin can be tested without publishing,
	-- and the bot decides whether to keep those.
	if game.PrivateServerId ~= "" then return end

	local Config = loadConfig()
	if not Config or Config.CommandLogsEnabled == false then return end

	local isStudio = RunService:IsStudio()
	-- Studio has no JobId, so the playtest gets one of its own to be threaded by.
	local jobId = game.JobId ~= "" and game.JobId or ("studio-" .. HttpService:GenerateGUID(false))
	local serverType = isStudio and "STUDIO" or "PUBLIC"
	local groupId = Config.GroupId or 0
	local flushSeconds = Config.CommandLogFlushSeconds or DEFAULT_FLUSH_SECONDS
	local pollSeconds = Config.CommandBlockPollSeconds or DEFAULT_BLOCK_POLL_SECONDS
	local maximumPending = Config.CommandLogMaximumPending or DEFAULT_MAXIMUM_PENDING
	local retryBaseSeconds = Config.RetryBaseSeconds or DEFAULT_RETRY_BASE_SECONDS
	local retryMaximumSeconds = Config.RetryMaximumSeconds or DEFAULT_RETRY_MAXIMUM_SECONDS

	local pending = {}
	local blockedUntil = {}
	local closing = false
	local flushing = false
	local retryAttempt = 0
	local retryScheduled = false

	local function request(path, method, body)
		return pcall(function()
			return HttpService:RequestAsync({
				Url = Config.IngestionBaseUrl .. path,
				Method = method,
				Headers = {
					["Authorization"] = "Bearer " .. Config.IngestionSecret,
					["Content-Type"] = "application/json",
				},
				Body = body and HttpService:JSONEncode(body) or nil,
			})
		end)
	end

	local function flush()
		if flushing then return #pending == 0 end
		flushing = true

		while #pending > 0 do
			local count = math.min(#pending, 100)
			local batch = table.create(count)
			for index = 1, count do batch[index] = pending[index] end

			local ok, response = request("/v1/roblox/commands/batch", "POST", { events = batch })
			if not ok or not response then
				warn("CommandLogs delivery failed", response)
				retryAttempt += 1
				flushing = false
				return false
			end

			if not response.Success then
				local status = response.StatusCode or 0
				-- A rejected batch is rejected for good: the wrong universe, the
				-- wrong secret, or a payload this bot does not accept. Retrying it
				-- would block every command behind it forever, so it goes, loudly.
				if status >= 400 and status < 500 and status ~= 408 and status ~= 429 then
					warn(string.format("CommandLogs: the bot refused a batch of %d (HTTP %d); dropping it", count, status))
				else
					warn("CommandLogs delivery failed", status)
					retryAttempt += 1
					flushing = false
					return false
				end
			end

			for _ = 1, count do table.remove(pending, 1) end
		end

		flushing = false
		retryAttempt = 0
		return true
	end

	local function requestFlush()
		if flushing or retryScheduled then return end
		retryScheduled = true
		local delay = retryAttempt == 0 and 0 or math.min(retryMaximumSeconds, retryBaseSeconds * (2 ^ (retryAttempt - 1)))
		delay += math.random() * math.min(1, delay * 0.25)
		task.delay(delay, function()
			retryScheduled = false
			if flush() == false and not closing then requestFlush() end
		end)
	end

	local function enqueue(event)
		if #pending >= maximumPending then
			-- Every queued event is a command somebody ran, so none of them is
			-- replaceable. The oldest goes, and says so.
			warn("CommandLogs queue full; dropping the oldest command run")
			table.remove(pending, 1)
		end
		table.insert(pending, event)
		requestFlush()
	end

	--[[ The level a command demands. Adonis allows a number, a rank name, or a
		list of either, and the bot reads risk from that number. ]]
	local function requiredLevel(adminLevel)
		if type(adminLevel) == "number" then return adminLevel end
		if type(adminLevel) == "string" then
			local ok, level = pcall(server.Admin.StringToComLevel, adminLevel)
			return (ok and type(level) == "number") and level or 0
		end
		if type(adminLevel) == "table" then
			local highest = 0
			for _, entry in adminLevel do
				local level = requiredLevel(entry)
				if level > highest then highest = level end
			end
			return highest
		end
		return 0
	end

	--[[ Who the command was run on. Adonis names its arguments, so an argument
		called "player" or "plr" is resolved the same way the command itself
		resolved it. ]]
	local function targetsOf(player, command, args)
		local names = {}
		local seen = {}
		for index, argument in ipairs(command.Args or command.Arguments or {}) do
			local name = string.lower(tostring(argument))
			if (string.find(name, "player", 1, true) or string.find(name, "plr", 1, true)) and args[index] then
				local ok, found = pcall(service.GetPlayers, player, args[index], { UseFakePlayer = true })
				if ok and type(found) == "table" then
					for _, target in found do
						local targetName = type(target) == "userdata" and target.Name or tostring(target)
						if not seen[targetName] and #names < TARGET_LIMIT then
							seen[targetName] = true
							table.insert(names, targetName)
						end
					end
				end
			end
		end
		return names
	end

	--[[ The alias as typed, with the prefix taken off: ":kick" becomes "kick". ]]
	local function aliasOf(matched, command)
		local alias = matched and string.match(tostring(matched), "[%a%d_]+$")
		if alias and alias ~= "" then return string.lower(alias) end
		local first = command.Commands and command.Commands[1]
		return string.lower(tostring(first or "unknown"))
	end

	local function rankOf(player)
		if groupId == 0 then return 0, "No group configured" end
		local ok, group = pcall(server.Admin.GetPlayerGroup, player, groupId)
		if ok and type(group) == "table" and type(group.Rank) == "number" then
			return group.Rank, tostring(group.Role or ("Rank " .. group.Rank))
		end
		return 0, "Not in group"
	end

	service.Events.CommandRan:Connect(function(player, data)
		-- Commands the server runs itself have no staff member behind them, and
		-- a command that failed never took effect.
		if typeof(player) ~= "Instance" or not player:IsA("Player") then return end
		if not data or data.Success ~= true then return end
		if data.Options and (data.Options.isSystem or data.Options.DontLog) then return end
		local command = data.Command
		if not command or command.NoLog then return end

		local rankNumber, rankName = rankOf(player)
		enqueue({
			eventId = HttpService:GenerateGUID(false),
			occurredAt = DateTime.now():ToIsoDate(),
			universeId = tostring(game.GameId),
			placeId = tostring(game.PlaceId),
			jobId = jobId,
			serverType = serverType,
			playerCount = #Players:GetPlayers(),
			maxPlayers = Players.MaxPlayers,
			runner = {
				userId = tostring(player.UserId),
				username = player.Name,
				rankNumber = rankNumber,
				rankName = rankName,
				adminLevel = (data.PlayerData and data.PlayerData.Level) or 0,
			},
			command = {
				text = tostring(data.Message),
				-- Adonis reports the index it registered the command under, which
				-- is rarely what was typed: ":cmds" arrives as "ViewCommands".
				-- Both go over the wire so the bot can recognise either.
				name = string.lower(tostring(data.Index or (command.Commands and command.Commands[1]) or "unknown")),
				alias = aliasOf(data.Matched, command),
				requiredLevel = requiredLevel(command.AdminLevel),
			},
			targets = targetsOf(player, command, data.Args or {}),
		})
	end)

	--[[ Blocks are pulled rather than pushed: the bot has no way into a running
		server without an Open Cloud key, and polling also works in Studio. ]]
	local function pollBlocks()
		local ok, response = request("/v1/roblox/command-blocks", "GET", nil)
		if not ok or not response or not response.Success then return end
		local decoded, body = pcall(HttpService.JSONDecode, HttpService, response.Body)
		if not decoded or type(body) ~= "table" or type(body.blocks) ~= "table" then return end

		local fresh = {}
		for _, block in body.blocks do
			local userId = tonumber(block.userId)
			local expiresAt = block.expiresAt and DateTime.fromIsoDate(block.expiresAt)
			if userId and expiresAt then fresh[userId] = expiresAt.UnixTimestamp end
		end
		blockedUntil = fresh
	end

	local function blockExpiryFor(player)
		local expiry = blockedUntil[player.UserId]
		if not expiry then return nil end
		if expiry <= DateTime.now().UnixTimestamp then
			blockedUntil[player.UserId] = nil
			return nil
		end
		return expiry
	end

	--[[ Enforcement wraps Process.Command rather than using Adonis's own
		blacklist, because the blacklist is skipped for the place owner and for
		Creators — including whoever is testing in Studio. Everything else about
		the call is passed straight through, batch keys and return values
		included. ]]
	local originalCommand = server.Process.Command
	server.Process.Command = function(player, message, options, ...)
		if typeof(player) == "Instance" and player:IsA("Player") and not (options and options.isSystem) then
			local expiry = blockExpiryFor(player)
			if expiry then
				local minutes = math.max(1, math.ceil((expiry - DateTime.now().UnixTimestamp) / 60))
				pcall(server.Remote.MakeGui, player, "Output", {
					Title = "Commands disabled",
					Message = string.format("Your command access was disabled from Discord. It comes back in about %d minute(s).", minutes),
				})
				return
			end
		end
		return originalCommand(player, message, options, ...)
	end

	task.spawn(function()
		while not closing do
			pollBlocks()
			task.wait(pollSeconds)
		end
	end)

	task.spawn(function()
		while not closing do
			task.wait(flushSeconds)
			if #pending > 0 then flush() end
		end
	end)

	game:BindToClose(function()
		closing = true
		local deadline = os.clock() + 8
		repeat
			if flush() then break end
			task.wait(1)
		until os.clock() >= deadline
	end)
end
