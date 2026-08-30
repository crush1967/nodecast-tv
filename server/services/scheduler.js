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

async function checkSchedules(app) {
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
            // Mirror the linked recording's final status once it's done, so the
            // schedule list doesn't sit stuck on "Recording" forever.
            const recording = await db.recordings.getById(schedule.recordingId);
            if (recording && (recording.status === 'completed' || recording.status === 'error')) {
                await db.schedules.update(schedule.id, { status: recording.status });
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
