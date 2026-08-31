/**
 * Scheduled Recording Service
 *
 * Persisted "record channel X from startAt to endAt" entries, checked on an
 * interval so they fire even if nobody has the app open - and checked once at
 * startup too, so a schedule whose start time passed while the server was
 * down still begins recording (late, for whatever's left of its window)
 * instead of silently never firing.
 */

const db = require('../db');
const recordingSession = require('./recordingSession');
const xtreamApi = require('./xtreamApi');
const diskGuard = require('./diskGuard');

const CHECK_INTERVAL_MS = 30 * 1000;

/**
 * Resolve a schedule's channel reference to a live stream URL, fresh at
 * execution time rather than baked in at creation time - an Xtream provider's
 * signed URL can rotate/expire over the hours between scheduling and firing.
 */
async function resolveChannelUrl(schedule) {
    if (schedule.sourceId != null && schedule.streamId != null) {
        const source = await db.sources.getById(schedule.sourceId);
        if (!source || source.type !== 'xtream') {
            throw new Error('Source not found or not an Xtream source');
        }
        const api = xtreamApi.createFromSource(source);
        return api.buildStreamUrl(schedule.streamId, 'live', 'm3u8');
    }
    if (schedule.url) return schedule.url;
    throw new Error('Schedule has no resolvable channel reference');
}

async function startDueSchedule(schedule, ffmpegPath, userAgent, settings) {
    const now = Date.now();
    const endAt = new Date(schedule.endAt).getTime();
    const durationMs = endAt - now;
    const maxDurationMs = (settings.maxRecordingHours || 4) * 60 * 60 * 1000;

    const minFreeGB = settings.minFreeDiskSpaceGB || 5;
    if (!(await diskGuard.hasEnoughSpace(minFreeGB))) {
        console.error(`[Scheduler] Skipping schedule ${schedule.id} ("${schedule.channelName}") - free disk space is below ${minFreeGB}GB`);
        await db.schedules.update(schedule.id, { status: 'error' });
        return;
    }

    try {
        const url = await resolveChannelUrl(schedule);
        const { session, recordingRow } = await recordingSession.startRecording({
            url, channelName: schedule.channelName, durationMs, maxDurationMs, ffmpegPath, userAgent
        });
        await db.schedules.update(schedule.id, { status: 'recording', recordingId: recordingRow.id });
        console.log(`[Scheduler] Started scheduled recording "${schedule.channelName}" (schedule ${schedule.id} -> recording ${recordingRow.id}, session ${session.id})`);
    } catch (err) {
        console.error(`[Scheduler] Failed to start schedule ${schedule.id}:`, err.message);
        await db.schedules.update(schedule.id, { status: 'error' });
    }
}

// Guards against overlapping ticks. checkSchedules can run long - joining a
// multi-GB orphaned recording's part files (see the 'recording' branch
// below) can easily take longer than CHECK_INTERVAL_MS, especially with AV
// scanning in the way on Windows - and setInterval doesn't wait for a
// previous invocation to finish before firing the next one. Without this, a
// second overlapping tick would find the exact same orphaned recording
// again (its status doesn't flip to 'completed' until the slow join
// finishes) and start a SECOND concurrent join of the same part files into
// the same destination file - two independent write cursors on the same
// path, each unaware of the other's progress, silently corrupting/
// truncating the result and then both unlinking the source parts anyway.
let checkInFlight = false;

async function checkSchedules(app) {
    if (checkInFlight) return;
    checkInFlight = true;
    try {
        await checkSchedulesOnce(app);
    } finally {
        checkInFlight = false;
    }
}

async function checkSchedulesOnce(app) {
    const now = Date.now();
    const all = await db.schedules.getAll();

    for (const schedule of all) {
        if (schedule.status === 'scheduled') {
            const startAt = new Date(schedule.startAt).getTime();
            const endAt = new Date(schedule.endAt).getTime();

            if (now >= endAt) {
                // The whole window passed without ever starting (e.g. server was
                // down the entire time) - nothing useful left to record.
                await db.schedules.update(schedule.id, { status: 'missed' });
            } else if (now >= startAt) {
                const ffmpegPath = app.locals.ffmpegPath || 'ffmpeg';
                const settings = await db.settings.get();
                const userAgent = db.getUserAgent(settings);
                await startDueSchedule(schedule, ffmpegPath, userAgent, settings);
            }
        } else if (schedule.status === 'recording' && schedule.recordingId) {
            const recording = await db.recordings.getById(schedule.recordingId);
            if (recording && (recording.status === 'completed' || recording.status === 'error')) {
                // Mirror the linked recording's final status once it's done, so
                // the schedule list doesn't sit stuck on "Recording" forever.
                await db.schedules.update(schedule.id, { status: recording.status });
            } else if (recording && recording.status === 'recording' && !recordingSession.getSessionByDbId(recording.id)) {
                // The db row still says "recording" but there's no live
                // in-memory session backing it - the only way that happens is
                // the whole server restarted mid-recording (a within-process
                // FFmpeg crash is already handled by RecordingSession's own
                // restart logic and never leaves this gap). What's already
                // been captured stays as its own completed recording; if the
                // schedule's window hasn't fully elapsed, pick back up with a
                // fresh recording covering what's left, linked to the same
                // schedule so the list reflects it resumed rather than died.
                const endAt = new Date(schedule.endAt).getTime();
                // The data survived as part files (abc123_part1.ts etc.) even
                // though the RecordingSession instance that was tracking them
                // didn't survive the restart - join them into the filename
                // this db row already expects, same as a live session's own
                // joinParts() would, before recording the final size.
                const sizeBytes = await recordingSession.joinOrphanedParts(recording.filename);
                await db.recordings.update(recording.id, {
                    status: 'completed',
                    stoppedAt: new Date().toISOString(),
                    sizeBytes: sizeBytes != null ? sizeBytes : recording.sizeBytes
                });
                console.warn(`[Scheduler] Recording ${recording.id} for schedule ${schedule.id} ("${schedule.channelName}") was orphaned by a server restart - closing it out at whatever was captured.`);
                if (now < endAt) {
                    await db.schedules.update(schedule.id, { status: 'scheduled', recordingId: null });
                    const ffmpegPath = app.locals.ffmpegPath || 'ffmpeg';
                    const settings = await db.settings.get();
                    const userAgent = db.getUserAgent(settings);
                    await startDueSchedule(schedule, ffmpegPath, userAgent, settings);
                } else {
                    await db.schedules.update(schedule.id, { status: 'completed' });
                }
            }
        }
    }
}

let checkInterval = null;

function startScheduler(app) {
    // Catch anything whose start time already passed while the server was down
    checkSchedules(app).catch(err => console.error('[Scheduler] Initial check failed:', err));

    if (!checkInterval) {
        checkInterval = setInterval(() => {
            checkSchedules(app).catch(err => console.error('[Scheduler] Check failed:', err));
        }, CHECK_INTERVAL_MS);
        checkInterval.unref(); // Don't prevent process exit
    }
    console.log('[Scheduler] Started - checking schedules every 30s');
}

module.exports = { startScheduler, checkSchedules, resolveChannelUrl };
