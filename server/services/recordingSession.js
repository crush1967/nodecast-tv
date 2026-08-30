/**
 * Recording Session Service
 *
 * Manages manual "record now" sessions: a single FFmpeg process that
 * remux-copies a live stream straight to a file on disk, with no
 * transcoding/segmenting involved.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const EventEmitter = require('events');
const db = require('../db');

const RECORDINGS_DIR = path.join(process.cwd(), 'recordings');

// Fallback if a caller forgets to pass maxDurationMs explicitly - matches the
// default maxRecordingHours setting. Every recording gets SOME hard ceiling,
// never truly "run forever" even if nothing else requested a duration.
const DEFAULT_MAX_DURATION_MS = 8 * 60 * 60 * 1000;

const sessions = new Map();

function generateSessionId() {
    return crypto.randomBytes(8).toString('hex');
}

async function ensureRecordingsDir() {
    await fs.mkdir(RECORDINGS_DIR, { recursive: true });
}

/**
 * RecordingSession class
 * Spawns FFmpeg to copy (no re-encode) a stream URL to a .ts file.
 *
 * Output is MPEG-TS rather than MP4: with -c copy, a .ts file stays
 * playable no matter when the process is killed, since there's no
 * moov atom to finalize the way MP4 needs.
 */
class RecordingSession extends EventEmitter {
    constructor(url, options = {}) {
        super();
        this.id = generateSessionId();
        this.url = url;
        this.channelName = options.channelName || 'Unknown Channel';
        this.filename = `${this.id}.ts`;
        this.filePath = path.join(RECORDINGS_DIR, this.filename);
        this.process = null;
        this.status = 'starting'; // starting | recording | stopped | error
        this.error = null;
        this.startedAt = Date.now();
        this.stoppedAt = null;

        // Hard ceiling: never later than this, no matter what durationMs was
        // requested (or not requested) and no matter how many times extendTo /
        // setAutoStopAt gets called afterward. This is the actual disk-space
        // failsafe backstop - it must not be bypassable by "just ask for more".
        const maxDurationMs = options.maxDurationMs || DEFAULT_MAX_DURATION_MS;
        this.hardMaxAt = this.startedAt + maxDurationMs;

        // Requested duration honored as-is if within the cap; no request (null,
        // "record until stopped") or a request beyond the cap both fall back
        // to the cap itself.
        const requestedMs = options.durationMs || null;
        this.durationMs = (requestedMs != null && requestedMs < maxDurationMs) ? requestedMs : maxDurationMs;
        this.autoStopAt = this.startedAt + this.durationMs;
        this.autoStopTimer = null;
        this.options = {
            ffmpegPath: options.ffmpegPath || 'ffmpeg',
            userAgent: options.userAgent || 'Mozilla/5.0'
        };
    }

    start() {
        // Route through our own proxy rather than hitting the provider directly.
        // FFmpeg's HLS demuxer reloads the playlist by re-polling this exact URL
        // rather than re-following the provider's redirect fresh each time, so a
        // direct -i here dies once the provider's short-lived signed token
        // expires - fatal for a recording that's meant to run unattended for a
        // long stretch. The proxy does a fresh fetch (and fresh redirect) on
        // every request instead. Same fix already applied to live TranscodeSession.
        const inputUrl = `http://localhost:${process.env.PORT || 3000}/api/proxy/stream?url=${encodeURIComponent(this.url)}`;
        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-user_agent', this.options.userAgent,
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '3',
            '-fflags', '+genpts+discardcorrupt',
            '-err_detect', 'ignore_err',
            '-i', inputUrl,
            '-map', '0:v:0',
            '-map', '0:a:0?',
            '-c', 'copy',
            '-f', 'mpegts',
            this.filePath
        ];

        console.log(`[RecordingSession ${this.id}] Starting recording for "${this.channelName}": ${this.url}`);
        console.log(`[RecordingSession ${this.id}] Command: ${this.options.ffmpegPath} ${args.join(' ')}`);

        try {
            this.process = spawn(this.options.ffmpegPath, args, { windowsHide: true });
            this.status = 'recording';

            if (this.durationMs) {
                this.autoStopTimer = setTimeout(() => {
                    console.log(`[RecordingSession ${this.id}] Duration reached, auto-stopping`);
                    this.stop();
                }, this.durationMs);
            }

            let stderrBuffer = '';
            this.process.stderr.on('data', (data) => {
                stderrBuffer += data.toString();
                const lines = stderrBuffer.split('\n');
                if (lines.length > 1) {
                    lines.slice(0, -1).forEach(line => {
                        if (line.trim()) console.log(`[FFmpeg Recording ${this.id}] ${line}`);
                    });
                    stderrBuffer = lines[lines.length - 1];
                }
            });

            this.process.on('exit', (code) => {
                if (this.autoStopTimer) {
                    clearTimeout(this.autoStopTimer);
                    this.autoStopTimer = null;
                }
                if (code !== 0 && code !== null && code !== 255) {
                    console.error(`[RecordingSession ${this.id}] FFmpeg exited with code ${code}`);
                    this.status = 'error';
                    this.error = `FFmpeg exited with code ${code}`;
                } else {
                    this.status = 'stopped';
                }
                this.stoppedAt = Date.now();
                this.process = null;
                this.emit('exit', code);
            });

            this.process.on('error', (err) => {
                console.error(`[RecordingSession ${this.id}] FFmpeg error:`, err);
                this.status = 'error';
                this.error = err.message;
                this.emit('error', err);
            });
        } catch (err) {
            this.status = 'error';
            this.error = err.message;
            throw err;
        }
    }

    /**
     * Reschedule the auto-stop to a new absolute timestamp, replacing whatever
     * timer (if any) was already set. Used to "add more time" to a schedule
     * that's already actively recording, without restarting the FFmpeg process.
     */
    setAutoStopAt(timestampMs) {
        // The hard cap always wins - "extend" can push the stop time later,
        // but never past hardMaxAt. Otherwise the disk-space failsafe would be
        // trivially bypassable by just clicking "+30m" enough times.
        const clamped = Math.min(timestampMs, this.hardMaxAt);

        if (this.autoStopTimer) {
            clearTimeout(this.autoStopTimer);
            this.autoStopTimer = null;
        }

        this.autoStopAt = clamped;
        this.durationMs = clamped - this.startedAt;

        const remainingMs = clamped - Date.now();
        if (remainingMs <= 0) {
            this.stop();
            return;
        }

        this.autoStopTimer = setTimeout(() => {
            console.log(`[RecordingSession ${this.id}] Duration reached, auto-stopping`);
            this.stop();
        }, remainingMs);
    }

    /**
     * Stop the recording and resolve once FFmpeg has actually exited
     * (so the caller can safely stat the finished file).
     */
    stop(timeoutMs = 5000) {
        if (this.autoStopTimer) {
            clearTimeout(this.autoStopTimer);
            this.autoStopTimer = null;
        }

        if (!this.process) {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            const onExit = () => resolve();
            this.once('exit', onExit);

            console.log(`[RecordingSession ${this.id}] Stopping FFmpeg process`);
            this.process.kill('SIGTERM');

            const killTimer = setTimeout(() => {
                if (this.process) this.process.kill('SIGKILL');
            }, 2000);

            setTimeout(() => {
                clearTimeout(killTimer);
                this.removeListener('exit', onExit);
                resolve();
            }, timeoutMs);
        });
    }
}

async function createSession(url, options = {}) {
    await ensureRecordingsDir();
    const session = new RecordingSession(url, options);
    sessions.set(session.id, session);
    return session;
}

function getSession(sessionId) {
    return sessions.get(sessionId);
}

/** Find the in-memory session backing a db recording row, if it's still active. */
function getSessionByDbId(dbId) {
    return Array.from(sessions.values()).find(s => s.dbId === dbId);
}

function removeSession(sessionId) {
    sessions.delete(sessionId);
}

function getAllActiveSessions() {
    return Array.from(sessions.values())
        .filter(s => s.status === 'starting' || s.status === 'recording')
        .map(s => ({
            id: s.dbId, // the db row id - what /stop and /delete actually expect
            sessionId: s.id, // internal ffmpeg session id, for debugging only
            channelName: s.channelName,
            url: s.url,
            status: s.status,
            startedAt: s.startedAt,
            autoStopAt: s.autoStopAt
        }));
}

/**
 * Write the final db row (status/size) once ffmpeg has actually exited.
 * Called both from the session's own 'exit' listener (covers duration auto-stop,
 * where nothing is waiting on a request) and explicitly awaited by a manual
 * /stop (so its response reflects the true final state instead of racing this
 * listener's async work). Guarded by session.finalized so whichever caller gets
 * there first wins.
 */
async function finalizeRecording(session) {
    if (session.finalized) return;
    session.finalized = true;
    try {
        const stat = await fs.stat(session.filePath).catch(() => null);
        await db.recordings.update(session.dbId, {
            status: session.status === 'error' ? 'error' : 'completed',
            stoppedAt: new Date().toISOString(),
            sizeBytes: stat ? stat.size : null
        });
    } catch (err) {
        console.error('[RecordingSession] Failed to finalize recording metadata:', err);
    } finally {
        removeSession(session.id);
    }
}

/**
 * Full start-a-recording sequence: create the ffmpeg session, create its
 * matching db row, link them, start recording, and auto-finalize on exit.
 * Shared by the manual /start route and the schedule checker - both need the
 * exact same sequence, so it lives here instead of being duplicated.
 */
async function startRecording({ url, channelName, durationMs, maxDurationMs, ffmpegPath, userAgent }) {
    const session = await createSession(url, { ffmpegPath, userAgent, channelName, durationMs, maxDurationMs });
    const recordingRow = await db.recordings.create({
        channelName: session.channelName,
        url,
        filename: session.filename
    });
    session.dbId = recordingRow.id;
    session.start();
    session.once('exit', () => finalizeRecording(session));
    return { session, recordingRow };
}

module.exports = {
    RecordingSession,
    createSession,
    getSession,
    getSessionByDbId,
    removeSession,
    getAllActiveSessions,
    startRecording,
    finalizeRecording,
    RECORDINGS_DIR
};
