-- Place this LocalScript in StarterPlayerScripts.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")

local player = Players.LocalPlayer
local activityEvent = ReplicatedStorage:WaitForChild("SessionTrackerActivity")
local lastInput = 0
local lastMovement = 0

UserInputService.InputBegan:Connect(function(_, gameProcessed)
	if gameProcessed then return end
	local now = os.clock()
	if now - lastInput >= 1 then
		lastInput = now
		activityEvent:FireServer("input")
	end
end)

task.spawn(function()
	while true do
		task.wait(1)
		local root = player.Character and player.Character:FindFirstChild("HumanoidRootPart")
		local humanoid = player.Character and player.Character:FindFirstChildOfClass("Humanoid")
		if root and humanoid and humanoid.MoveDirection.Magnitude > 0 and os.clock() - lastMovement >= 1 then
			lastMovement = os.clock()
			activityEvent:FireServer("movement", root.Position)
		end
	end
end)
