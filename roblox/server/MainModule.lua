-- ServerScriptService.SessionTracker.MainModule
-- All server-side tracking behavior lives in this module. Bootstrap.server.lua
-- is intentionally limited to calling start(), because ModuleScripts do not run
-- on their own.
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Config = require(script.Parent:WaitForChild("Config"))

local SessionTracker = {}
local started = false

local function createActivityEvent()
	local existing = ReplicatedStorage:FindFirstChild("SessionTrackerActivity")
	if existing then
		assert(existing:IsA("RemoteEvent"), "ReplicatedStorage.SessionTrackerActivity must be a RemoteEvent")
		return existing
	end

	local event = Instance.new("RemoteEvent")
	event.Name = "SessionTrackerActivity"
	event.Parent = ReplicatedStorage
	return event
end

function SessionTracker.start()
	if started then return end
	started = true

	local jobId = game.JobId ~= "" and game.JobId or ("studio-" .. tostring(game.PlaceId))
	local activityEvent = createActivityEvent()
	local tracked = {}
	local pending = {}
	local closing = false
	local flushing = false

	local function enqueue(kind, record)
		table.insert(pending, {
			eventId = HttpService:GenerateGUID(false),
			kind = kind,
			occurredAt = DateTime.now():ToIsoDate(),
			universeId = tostring(game.GameId),
			placeId = tostring(game.PlaceId),
			jobId = jobId,
			player = {
				userId = tostring(record.player.UserId),
				username = record.player.Name,
				rankNumber = record.rankNumber,
				rankName = record.rankName,
				active = os.clock() - record.lastActivity < Config.InactiveSeconds,
			},
		})
	end

	local function flush()
		if flushing then return #pending == 0 end
		flushing = true

		while #pending > 0 do
			local count = math.min(#pending, 100)
			local batch = table.create(count)
			for index = 1, count do batch[index] = pending[index] end
			local ok, response = pcall(function()
				return HttpService:RequestAsync({
					Url = Config.IngestionBaseUrl .. "/v1/roblox/presence/batch",
					Method = "POST",
					Headers = {
						["Authorization"] = "Bearer " .. Config.IngestionSecret,
						["Content-Type"] = "application/json",
					},
					Body = HttpService:JSONEncode({ events = batch }),
				})
			end)

			if not ok or not response or not response.Success then
				warn("SessionTracker delivery failed", ok and response and response.StatusCode or response)
				flushing = false
				return false
			end

			for _ = 1, count do table.remove(pending, 1) end
		end

		flushing = false
		return true
	end

	local function requestFlush()
		if not flushing then task.spawn(flush) end
	end

	local function addPlayer(player)
		local ok, rankNumber = pcall(player.GetRankInGroup, player, Config.GroupId)
		if not ok or rankNumber < Config.MinimumRank or rankNumber > Config.MaximumRank then return end

		local rankOk, rankName = pcall(player.GetRoleInGroup, player, Config.GroupId)
		local record = {
			player = player,
			rankNumber = rankNumber,
			rankName = rankOk and rankName or ("Rank " .. rankNumber),
			lastActivity = os.clock(),
			lastClientReport = 0,
			lastPosition = nil,
		}
		tracked[player] = record
		enqueue("JOIN", record)
		requestFlush()
	end

	local function removePlayer(player)
		local record = tracked[player]
		if not record then return end
		enqueue(closing and "SHUTDOWN" or "LEAVE", record)
		tracked[player] = nil
		if not closing then requestFlush() end
	end

	activityEvent.OnServerEvent:Connect(function(player, reportType, reportedPosition)
		local record = tracked[player]
		if not record or (reportType ~= "input" and reportType ~= "movement") then return end

		local now = os.clock()
		if now - record.lastClientReport < Config.ClientReportMinimumInterval then return end
		record.lastClientReport = now

		if reportType == "movement" then
			if typeof(reportedPosition) ~= "Vector3" then return end
			local root = player.Character and player.Character:FindFirstChild("HumanoidRootPart")
			if not root or (root.Position - reportedPosition).Magnitude > 12 then return end
			if record.lastPosition and (record.lastPosition - reportedPosition).Magnitude < 0.25 then return end
			record.lastPosition = reportedPosition
		end

		record.lastActivity = now
	end)

	Players.PlayerAdded:Connect(addPlayer)
	Players.PlayerRemoving:Connect(removePlayer)
	for _, player in Players:GetPlayers() do task.spawn(addPlayer, player) end

	task.spawn(function()
		while not closing do
			task.wait(Config.HeartbeatSeconds)
			for _, record in tracked do enqueue("HEARTBEAT", record) end
			flush()
		end
	end)

	game:BindToClose(function()
		closing = true
		for _, record in tracked do enqueue("SHUTDOWN", record) end
		local deadline = os.clock() + 8
		repeat
			if flush() then break end
			task.wait(1)
		until os.clock() >= deadline
	end)
end

return SessionTracker
