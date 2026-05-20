local uuid = session:get_uuid()
local result = freeswitch.API():executeString(
  "uuid_audio_stream " .. uuid .. " start ws://127.0.0.1:8080 mono 8000"
)
freeswitch.consoleLog("INFO", "audio_stream start: " .. tostring(result) .. "\n")
