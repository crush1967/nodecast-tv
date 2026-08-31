/**
 * Recording Session Service
 *
 * Manages manual "record now" sessions: a single FFmpeg process that
 * remux-copies a live stream straight to a file on disk, with no
 * transcoding/segmenting involved.
 */

const { spawn } = require('child_process');
const path = require('path');
const fsSync = require('fs');
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
 * Join a list of part files (in order) into one destination file.
 * MPEG-TS parts concatenate byte-for-byte into one valid stream, so this is
 * a plain binary join, not a re-mux. Shared by RecordingSession.joinParts()
 * (live instance, still-in-memory parts list) and joinOrphanedParts() below
 * (recovering a recording whose parts survived a server restart but whose
 * owning RecordingSession instance didn't).
 */
async function joinPartFiles(parts, destPath, logId) {
    if (parts.length === 0) return;
    if (parts.length === 1) {
        // Common case (no restarts needed) - just rename, no copy.
        await fs.rename(parts[0], destPath).catch(async (err) => {
            // Cross-device or already-gone - fall back to copy+unlink.
            if (err.code === 'ENOENT') return;
            await fs.copyFile(parts[0], destPath);
            await fs.unlink(parts[0]).catch(() => {});
        });
        return;
    }

    // 'wx' (exclusive create) rather than 'w' - if a concurrent join is
    // already writing this exact destPath (e.g. two overlapping scheduler
    // ticks recovering the same orphaned recording - see checkSchedules'
    // checkInFlight guard for the full story), this throws instead of
    // silently truncating the other writer's already-written bytes: two
    // independent file handles both writing from offset 0 would otherwise
    // stomp on each other with no error, corrupting the result.
    let out;
    try {
        out = fsSync.createWriteStream(destPath, { flags: 'wx' });
        await new Promise((resolve, reject) => {
            out.once('open', resolve);
            out.once('error', reject);
        });
    } catch (err) {
        console.error(`[RecordingSession ${logId}] Destination already being written (concurrent join?) - not touching it:`, err.message);
        return;
    }

    // Streamed rather than fs.readFile()'d whole - a single part can run for
    // a long time before the next restart (or never restart at all), and
    // there's no reason to hold a multi-GB file in memory at once just to
    // copy it.
    const joinedParts = [];
    let writeError = null;
    out.on('error', (err) => { writeError = err; });

    for (const part of parts) {
        if (writeError) break; // destination itself is broken - no point reading more parts
        try {
            await new Promise((resolve, reject) => {
                const readStream = fsSync.createReadStream(part);
                readStream.on('error', reject);
                readStream.pipe(out, { end: false });
                readStream.on('end', resolve);
            });
            if (writeError) throw writeError;
            joinedParts.push(part);
        } catch (err) {
            // Not unlinked below - losing a whole part silently (as the old
            // fs.readFile()-per-part version did on any read/write error)
            // means real recorded footage gone for good. Leaving it on disk
            // keeps it recoverable/inspectable instead.
            console.error(`[RecordingSession ${logId}] Failed to append part ${part} - leaving it on disk instead of losing its content:`, err.message);
        }
    }

    await new Promise((resolve) => out.end(resolve));

    for (const part of joinedParts) {
        await fs.unlink(part).catch(() => {});
    }
}

/**
 * Recover a recording's part files after a full server restart, when there's
 * no live RecordingSession instance left to call joinParts() on (the
 * in-memory sessions Map doesn't survive process death). filename is the
 * db.recordings row's expected final name (e.g. "abc123.ts"); part files on
 * disk are named "abc123_part1.ts", "abc123_part2.ts", etc. Returns the
 * final file's size in bytes, or null if no parts (or already-joined final
 * file) were found.
 */
async function joinOrphanedParts(filename) {
    const baseId = filename.replace(/\.ts$/, '');
    const destPath = path.join(RECORDINGS_DIR, filename);

    const existingFinal = await fs.stat(destPath).catch(() => null);
    if (existingFinal) return existingFinal.size; // Already joined, nothing to do.

    const entries = await fs.readdir(RECORDINGS_DIR).catch(() => []);
    const partRegex = new RegExp(`^${baseId}_part(\\d+)\\.ts$`);
    const parts = entries
        .map(name => ({ name, match: name.match(partRegex) }))
        .filter(e => e.match)
        .sort((a, b) => parseInt(a.match[1]) - parseInt(b.match[1]))
        .map(e => path.join(RECORDINGS_DIR, e.name));

    if (parts.length === 0) return null;

    await joinPartFiles(parts, destPath, baseId);
    const stat = await fs.stat(destPath).catch(() => null);
    return stat ? stat.size : null;
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

        // This provider's connection resets (confirmed directly in FFmpeg's
        // own output: repeated "-10053"/connection-reset errors on live
        // playback and recordings alike) can eventually exhaust FFmpeg's own
        // -reconnect handling and kill the whole process - the HLS demuxer
        // doesn't retry indefinitely once it can't reload the playlist itself
        // (as opposed to a single segment, which -reconnect does cover). A
        // recording that dies at that point used to just... end early, short
        // of the requested duration, with nothing noticing. Below, an
        // unexpected exit before autoStopAt is treated as "keep recording,"
        // not "done" - each attempt writes its own part file (MPEG-TS parts
        // concatenate byte-for-byte into one valid stream, so this doesn't
        // need to be seamless at the container level), and finalize() joins
        // them into the single file callers expect once actually done.
        this.parts = [];
        this.partIndex = 0;
        this.restartAttempts = 0;
        // Generous budget, not a small fixed count - a multi-hour scheduled
        // recording needs to be able to ride out a genuinely bad stretch from
        // the provider (confirmed directly: one channel died repeatedly
        // within its first few minutes), not just one or two blips.
        this.MAX_RESTART_ATTEMPTS = 500;
        this.stopRequested = false;
    }

    /**
     * Cooldown before a restart attempt, growing with consecutive failures
     * (capped) instead of a flat interval - hammering a provider that's
     * already rejecting connections at a fixed short interval risks looking
     * like abuse and making the rejection last longer, not shorter.
     */
    getRestartCooldownMs() {
        return Math.min(3000 * this.restartAttempts, 30000);
    }

    start() {
        this.partIndex++;
        const partPath = path.join(RECORDINGS_DIR, `${this.id}_part${this.partIndex}.ts`);
        this.parts.push(partPath);

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
            partPath
        ];

        console.log(`[RecordingSession ${this.id}] Starting recording for "${this.channelName}" (part ${this.partIndex}): ${this.url}`);
        console.log(`[RecordingSession ${this.id}] Command: ${this.options.ffmpegPath} ${args.join(' ')}`);

        try {
            this.process = spawn(this.options.ffmpegPath, args, { windowsHide: true });
            this.status = 'recording';

            if (this.durationMs) {
                const remainingMs = this.autoStopAt - Date.now();
                this.autoStopTimer = setTimeout(() => {
                    console.log(`[RecordingSession ${this.id}] Duration reached, auto-stopping`);
                    this.stop();
                }, Math.max(0, remainingMs));
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
                this.process = null;
                const diedEarly = !this.stopRequested && Date.now() < this.autoStopAt;
                const isErrorExit = code !== 0 && code !== null && code !== 255;

                // diedEarly alone is the right restart signal, not diedEarly
                // && isErrorExit - confirmed directly: when FFmpeg's HLS
                // demuxer runs out of usable input after repeated 404s (the
                // provider connection resets exhausting -reconnect), it exits
                // with a CLEAN code, not an error one - FFmpeg treats "ran out
                // of data" as normal end-of-stream, not a crash. Gating the
                // restart on isErrorExit meant that exact failure mode - the
                // one actually being hit - silently skipped the restart logic
                // entirely and let the recording just end early.
                if (diedEarly && this.restartAttempts < this.MAX_RESTART_ATTEMPTS) {
                    this.restartAttempts++;
                    const cooldownMs = this.getRestartCooldownMs();
                    console.warn(`[RecordingSession ${this.id}] FFmpeg exited early with code ${code} (${Math.round((this.autoStopAt - Date.now()) / 1000)}s still wanted) - restarting as part ${this.partIndex + 1} in ${Math.round(cooldownMs / 1000)}s (attempt ${this.restartAttempts}/${this.MAX_RESTART_ATTEMPTS})`);
                    setTimeout(() => {
                        if (!this.stopRequested) this.start();
                    }, cooldownMs);
                    return;
                }

                if (this.autoStopTimer) {
                    clearTimeout(this.autoStopTimer);
                    this.autoStopTimer = null;
                }
                if (diedEarly) {
                    // Reaches here only once restart attempts are exhausted -
                    // the branch above already handles (and returns from)
                    // every early-exit case still within the retry budget.
                    console.error(`[RecordingSession ${this.id}] Gave up after ${this.restartAttempts} restart attempts`);
                    this.status = 'error';
                    this.error = `FFmpeg exited with code ${code} after ${this.restartAttempts} restart attempts`;
                } else if (isErrorExit) {
                    console.error(`[RecordingSession ${this.id}] FFmpeg exited with code ${code}`);
                    this.status = 'error';
                    this.error = `FFmpeg exited with code ${code}`;
                } else {
                    this.status = 'stopped';
                }
                this.stoppedAt = Date.now();
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
     * Join every part file (initial + any restarts) into the single file
     * this.filePath - callers (recording playback, the recordings list) only
     * know about that one path.
     */
    async joinParts() {
        await joinPartFiles(this.parts, this.filePath, this.id);
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
        // Set before touching the process - a pending restart (scheduled by
        // the exit handler after an early premature exit) checks this before
        // firing, so a stop() that lands during that brief cooldown window
        // correctly cancels the restart instead of racing it.
        this.stopRequested = true;

        if (this.autoStopTimer) {
            clearTimeout(this.autoStopTimer);
            this.autoStopTimer = null;
        }

        if (!this.process) {
            // No process right now doesn't necessarily mean this session is
            // actually done - it could be mid-cooldown, waiting to restart
            // after an early crash (stopRequested above just cancelled that
            // pending restart). Finalize properly here instead of leaving the
            // session stuck with no 'exit' ever emitted and its db row never
            // updated.
            if (this.status === 'recording') {
                this.status = 'stopped';
                this.stoppedAt = Date.now();
                this.emit('exit', 0);
            }
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
        await session.joinParts();
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
 * Sweep every db recording still marked 'recording' with no live in-memory
 * session behind it. The in-memory sessions Map (and everything it tracks -
 * status, parts, autoStopAt) doesn't survive a server restart or crash, but
 * on Windows a spawned FFmpeg child does (it isn't killed when the parent
 * process exits), so the recording is very often still actually running,
 * just orphaned from the app's tracking - the data that's already been
 * captured is safe as part files on disk though, and can be joined and
 * closed out the same way finalizeRecording() would if the process hadn't
 * died. Without this, an orphaned recording is stuck forever: unwatchable
 * (its /stream 404s - no session, no final file) and unstoppable (its
 * /stop is a silent no-op with nothing to stop).
 *
 * Only called once, at server startup - every 'recording' row found here is
 * guaranteed orphaned (the sessions Map is freshly empty), so this can't
 * clobber a real in-progress recording. Schedule-linked recordings are left
 * alone - scheduler.js's own startup check already recovers those, and (unlike
 * this) can resume recording for whatever's left of the schedule's window.
 */
async function reconcileOrphanedRecordings() {
    const [recordings, schedules] = await Promise.all([db.recordings.getAll(), db.schedules.getAll()]);
    const scheduleLinkedIds = new Set(
        schedules.filter(s => s.status === 'recording' && s.recordingId).map(s => s.recordingId)
    );

    for (const recording of recordings) {
        if (recording.status !== 'recording' || scheduleLinkedIds.has(recording.id)) continue;

        const sizeBytes = await joinOrphanedParts(recording.filename).catch((err) => {
            console.error(`[RecordingSession] Failed to join orphaned parts for recording ${recording.id}:`, err.message);
            return null;
        });
        await db.recordings.update(recording.id, {
            status: 'completed',
            stoppedAt: new Date().toISOString(),
            sizeBytes: sizeBytes != null ? sizeBytes : recording.sizeBytes
        });
        console.warn(`[RecordingSession] Recording ${recording.id} ("${recording.channelName}") was orphaned by a restart - closing it out at whatever was captured.`);
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
    joinOrphanedParts,
    reconcileOrphanedRecordings,
    RECORDINGS_DIR
};
