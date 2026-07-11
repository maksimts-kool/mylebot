-- Copy this to Config.lua and fill in the server-only values.
-- Config.lua is gitignored because it contains the ingestion secret.
return {
	IngestionBaseUrl = "https://sessions.example.com",
	IngestionSecret = "REPLACE_WITH_THE_SAME_RANDOM_SECRET_AS_THE_BACKEND",
	GroupId = 0,
	MinimumRank = 1,
	MaximumRank = 255,
	HeartbeatSeconds = 30,
	InactiveSeconds = 300,
	ClientReportMinimumInterval = 0.5,
}
