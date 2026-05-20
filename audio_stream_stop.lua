local uuid = session:get_uuid()
local result = freeswitch.API():executeString("uuid_audio_stream " .. uuid .. " stop")
freeswitch.consoleLog("INFO", "audio_stream stop: " .. tostring(result) .. "\n")
