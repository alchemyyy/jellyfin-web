local mp = require "mp"
local utils = require "mp.utils"

local MICROSECONDS_PER_SECOND = 1000000
local SEEK_TIMEOUT_SECONDS = 30
local PACING_SAMPLE_INTERVAL_SECONDS = 0.1

local plan_path = os.getenv("WEBGPU_MPV_CAPTURE_PLAN")
local report_path = os.getenv("WEBGPU_MPV_CAPTURE_REPORT")
local report = {
    captures = {},
    schemaVersion = 1,
    status = "starting"
}
local plan = nil
local state = "loading"
local capture_index = 1
local target_microseconds = nil
local watchdog_timer = nil
local settle_timer = nil
local pacing_timer = nil
local pacing_finish_timer = nil
local pacing_started_at_seconds = nil
local quitting = false

local function read_text_file(path)
    local file, open_error = io.open(path, "rb")
    if not file then
        return nil, open_error
    end
    local contents = file:read("*a")
    file:close()
    return contents, nil
end

local function write_report()
    if not report_path then
        return false, "WEBGPU_MPV_CAPTURE_REPORT is not set"
    end
    local file, open_error = io.open(report_path, "wb")
    if not file then
        return false, open_error
    end
    file:write(utils.format_json(report))
    file:write("\n")
    file:close()
    return true, nil
end

local function stop_timer(timer)
    if timer then
        timer:kill()
    end
end

local function stop_all_timers()
    stop_timer(watchdog_timer)
    stop_timer(settle_timer)
    stop_timer(pacing_timer)
    stop_timer(pacing_finish_timer)
    watchdog_timer = nil
    settle_timer = nil
    pacing_timer = nil
    pacing_finish_timer = nil
end

local function finish(status, error_message)
    if quitting then
        return
    end
    quitting = true
    stop_all_timers()
    report.status = status
    if error_message then
        report.error = tostring(error_message)
    end
    local written, write_error = write_report()
    if not written then
        mp.msg.error("Unable to write mpv reference report: " .. tostring(write_error))
    end
    mp.commandv("quit", status == "captured" and "0" or "2")
end

local function fail(error_message)
    finish("failed", error_message)
end

local function get_property(name)
    local succeeded, value = pcall(mp.get_property_native, name)
    if not succeeded then
        return nil
    end
    return value
end

local function seconds_to_microseconds(seconds)
    if type(seconds) ~= "number" then
        return nil
    end
    return math.floor(seconds * MICROSECONDS_PER_SECOND + 0.5)
end

local function read_playback_snapshot()
    return {
        audioCodec = get_property("audio-codec"),
        audioParams = get_property("audio-params"),
        containerFps = get_property("container-fps"),
        currentVo = get_property("current-vo"),
        decoderFrameDropCount = get_property("decoder-frame-drop-count"),
        delayedFrameCount = get_property("delayed-frame-count"),
        displayFps = get_property("display-fps"),
        estimatedVfFps = get_property("estimated-vf-fps"),
        frameDropCount = get_property("frame-drop-count"),
        hwdecCurrent = get_property("hwdec-current"),
        mediaTimeMicroseconds = seconds_to_microseconds(get_property("time-pos")),
        mistimedFrameCount = get_property("mistimed-frame-count"),
        pausedForCache = get_property("paused-for-cache"),
        targetParams = get_property("target-params"),
        videoCodec = get_property("video-codec"),
        videoOutParams = get_property("video-out-params"),
        videoParams = get_property("video-params"),
        vsyncJitter = get_property("vsync-jitter"),
        wallTimeSeconds = mp.get_time()
    }
end

local function read_pacing_sample()
    return {
        decoderFrameDropCount = get_property("decoder-frame-drop-count"),
        delayedFrameCount = get_property("delayed-frame-count"),
        frameDropCount = get_property("frame-drop-count"),
        mediaTimeMicroseconds = seconds_to_microseconds(get_property("time-pos")),
        mistimedFrameCount = get_property("mistimed-frame-count"),
        pausedForCache = get_property("paused-for-cache"),
        vsyncJitter = get_property("vsync-jitter"),
        wallTimeSeconds = mp.get_time()
    }
end

local function summarize_track_list()
    local track_list = get_property("track-list")
    local tracks = {}
    if type(track_list) ~= "table" then
        return tracks
    end
    for _, track in ipairs(track_list) do
        table.insert(tracks, {
            audioChannels = track["audio-channels"],
            codec = track.codec,
            decoder = track.decoder,
            default = track.default,
            demuxChannels = track["demux-channels"],
            demuxFps = track["demux-fps"],
            demuxHeight = track["demux-h"],
            demuxSampleRate = track["demux-samplerate"],
            demuxWidth = track["demux-w"],
            id = track.id,
            language = track.lang,
            selected = track.selected,
            title = track.title,
            type = track.type
        })
    end
    return tracks
end

local function arm_seek_watchdog(description)
    stop_timer(watchdog_timer)
    watchdog_timer = mp.add_timeout(SEEK_TIMEOUT_SECONDS, function()
        fail("Timed out waiting for " .. description)
    end)
end

local function seek_matches_target()
    local media_time_microseconds = seconds_to_microseconds(get_property("time-pos"))
    if type(media_time_microseconds) ~= "number" or type(target_microseconds) ~= "number" then
        return false
    end
    return math.abs(media_time_microseconds - target_microseconds)
        <= plan.captureToleranceMicroseconds
end

local begin_capture_seek
local begin_pacing_seek

local function capture_current_frame()
    if state ~= "capture-settling" then
        return
    end
    local capture = plan.captures[capture_index]
    if type(capture) ~= "table" then
        fail("Capture plan entry is missing")
        return
    end
    local succeeded, command_error = pcall(
        mp.commandv,
        "screenshot-to-file",
        capture.outputPath,
        "window"
    )
    if not succeeded then
        fail("mpv screenshot failed: " .. tostring(command_error))
        return
    end
    local snapshot = read_playback_snapshot()
    table.insert(report.captures, {
        actualMediaTimeMicroseconds = snapshot.mediaTimeMicroseconds,
        filename = capture.filename,
        requestedMediaTimeMicroseconds = capture.requestedMediaTimeMicroseconds,
        snapshot = snapshot
    })
    capture_index = capture_index + 1
    if capture_index <= #plan.captures then
        begin_capture_seek()
    else
        begin_pacing_seek()
    end
end

local function capture_pacing_sample()
    if state ~= "pacing-running" then
        return
    end
    table.insert(report.pacing.samples, read_pacing_sample())
end

local function finish_pacing_capture()
    if state ~= "pacing-running" then
        return
    end
    mp.set_property_native("pause", true)
    capture_pacing_sample()
    state = "finished"
    stop_timer(pacing_timer)
    pacing_timer = nil
    report.pacing.after = read_playback_snapshot()
    report.pacing.observedWallDurationMicroseconds = seconds_to_microseconds(
        mp.get_time() - pacing_started_at_seconds
    )
    finish("captured", nil)
end

local function begin_pacing_playback()
    if state ~= "pacing-settling" then
        return
    end
    report.pacing = {
        before = read_playback_snapshot(),
        durationMilliseconds = plan.pacing.durationMilliseconds,
        samples = {},
        startTimeMicroseconds = plan.pacing.startTimeMicroseconds
    }
    state = "pacing-running"
    pacing_started_at_seconds = mp.get_time()
    capture_pacing_sample()
    mp.set_property_native("pause", false)
    pacing_timer = mp.add_periodic_timer(
        PACING_SAMPLE_INTERVAL_SECONDS,
        capture_pacing_sample
    )
    pacing_finish_timer = mp.add_timeout(
        plan.pacing.durationMilliseconds / 1000,
        finish_pacing_capture
    )
end

begin_capture_seek = function()
    local capture = plan.captures[capture_index]
    if type(capture) ~= "table"
        or type(capture.requestedMediaTimeMicroseconds) ~= "number"
        or type(capture.outputPath) ~= "string"
        or type(capture.filename) ~= "string" then
        fail("Capture plan entry is invalid")
        return
    end
    state = "capture-seeking"
    target_microseconds = capture.requestedMediaTimeMicroseconds
    arm_seek_watchdog("capture seek")
    mp.commandv(
        "seek",
        string.format("%.6f", target_microseconds / MICROSECONDS_PER_SECOND),
        "absolute+exact"
    )
end

begin_pacing_seek = function()
    state = "pacing-seeking"
    target_microseconds = plan.pacing.startTimeMicroseconds
    arm_seek_watchdog("pacing seek")
    mp.commandv(
        "seek",
        string.format("%.6f", target_microseconds / MICROSECONDS_PER_SECOND),
        "absolute+exact"
    )
end

local function handle_playback_restart()
    if state ~= "capture-seeking" and state ~= "pacing-seeking" then
        return
    end
    if not seek_matches_target() then
        return
    end
    stop_timer(watchdog_timer)
    watchdog_timer = nil
    if state == "capture-seeking" then
        state = "capture-settling"
        settle_timer = mp.add_timeout(
            plan.settleMilliseconds / 1000,
            capture_current_frame
        )
    else
        state = "pacing-settling"
        settle_timer = mp.add_timeout(
            plan.settleMilliseconds / 1000,
            begin_pacing_playback
        )
    end
end

local function load_plan()
    if not plan_path then
        return false, "WEBGPU_MPV_CAPTURE_PLAN is not set"
    end
    local contents, read_error = read_text_file(plan_path)
    if not contents then
        return false, "Unable to read capture plan: " .. tostring(read_error)
    end
    local parsed, parse_error = utils.parse_json(contents)
    if type(parsed) ~= "table" then
        return false, "Unable to parse capture plan: " .. tostring(parse_error)
    end
    if parsed.schemaVersion ~= 1
        or type(parsed.captures) ~= "table"
        or #parsed.captures == 0
        or type(parsed.captureToleranceMicroseconds) ~= "number"
        or type(parsed.settleMilliseconds) ~= "number"
        or type(parsed.pacing) ~= "table"
        or type(parsed.pacing.startTimeMicroseconds) ~= "number"
        or type(parsed.pacing.durationMilliseconds) ~= "number" then
        return false, "Capture plan schema is invalid"
    end
    plan = parsed
    report.caseId = plan.caseId
    report.profile = plan.profile
    return true, nil
end

mp.register_event("file-loaded", function()
    if state ~= "loading" then
        return
    end
    mp.set_property_native("pause", true)
    report.file = {
        audioCodec = get_property("audio-codec"),
        durationMicroseconds = seconds_to_microseconds(get_property("duration")),
        trackList = summarize_track_list(),
        videoCodec = get_property("video-codec")
    }
    begin_capture_seek()
end)

mp.register_event("playback-restart", handle_playback_restart)

mp.register_event("end-file", function(event)
    if quitting or state == "finished" then
        return
    end
    fail("mpv ended before capture completion: " .. tostring(event.reason))
end)

local loaded, load_error = load_plan()
if not loaded then
    fail(load_error)
end
