const express = require('express');
const router = express.Router();
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../db');
const auth = require('../auth');
const recordingSession = require('../services/recordingSession');
const diskGuard = require('../services/diskGuard');
const transcodeSession = require('../services/transcodeSession');

/**
 * Recording Routes
 *
 * POST   /api/recordings/start      - Start recording a stream
 * POST   /api/recordings/:id/stop   - Stop an in-progress recording
 * GET    /api/recordings            - List all recordings (db rows)
 * GET    /api/recordings/active     - List currently-running recording sessions
 * GET    /api/recordings/:id/download - Download a completed recording
 * DELETE /api/recordings/:id        - Delete a recording (stops it first if active)
 */

// Accept the JWT via the Authorization header (normal API calls) OR a
// ?token= query param, since the Download button is a plain <a href>
// navigation that can't attach an Authorization header.
function authenticate(req, res, next) {
    const headerToken = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null;
    const token = headerToken || req.query.token;
    const payload = token && auth.verifyToken(token);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    req.user = payload;
    next();
}

router.use(authenticate);

/**
 * Start a recording
 * POST /api/recordings/start
 * Body: { url: string, channelName?: string, durationMinutes?: number }
 */
router.post('/start', async (req, res) => {
    const { url, channelName, durationMinutes } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);
    const durationMs = durationMinutes ? Math.round(Number(durationMinutes) * 60 * 1000) : null;
    const maxDurationMs = (settings.maxRecordingHours || 4) * 60 * 60 * 1000;

    if (!(await diskGuard.hasEnoughSpace(settings.minFreeDiskSpaceGB || 5))) {
        return res.status(507).json({ error: `Not enough free disk space to start recording (need at least ${settings.minFreeDiskSpaceGB || 5}GB free).` });
    }

    try {
        const { session, recordingRow } = await recordingSession.startRecording({
            url, channelName, durationMs, maxDurationMs, ffmpegPath, userAgent
        });
        res.json({ id: recordingRow.id, sessionId: session.id, status: session.status, autoStopAt: session.autoStopAt });
    } catch (err) {
        console.error('[Recordings] Failed to start recording:', err);
        res.status(500).json({ error: 'Failed to start recording', details: err.message });
    }
});

/**
 * Stop a recording
 * POST /api/recordings/:id/stop
 */
router.post('/:id/stop', async (req, res) => {
    const recording = await db.recordings.getById(req.params.id);
    if (!recording) {
        return res.status(404).json({ error: 'Recording not found' });
    }

    const session = recordingSession.getSessionByDbId(recording.id);

    if (!session) {
        // Already stopped/finalized elsewhere
        return res.json(recording);
    }

    await session.stop();
    await recordingSession.finalizeRecording(session); // guarded - no-op if the 'exit' listener already ran
    const updated = await db.recordings.getById(req.params.id);
    res.json(updated);
});

/**
 * List all recordings
 * GET /api/recordings
 */
router.get('/', async (req, res) => {
    try {
        const all = await db.recordings.getAll();
        // Nothing keeps the db row in sync if a file gets deleted outside the
        // app (e.g. manually from the recordings folder) - check on every list
        // so the UI can show that instead of only discovering it via a failed
        // Download click. Recording is actively 'recording' -> always exists,
        // skip the check for those.
        const withFileStatus = await Promise.all(all.map(async r => {
            const filePath = path.join(recordingSession.RECORDINGS_DIR, r.filename);

            if (r.status === 'recording') {
                // Current size + planned stop time, so the UI can extrapolate an
                // estimated final size while it's still in progress. While
                // actively recording, the data lives in part files (see
                // RecordingSession - a restart after a dropped connection
                // writes a new part rather than resuming the final filename
                // directly), which only get joined into r.filename once the
                // recording actually stops - so the size has to be summed
                // across whatever parts exist right now instead of stat-ing
                // a file that doesn't exist yet.
                const session = recordingSession.getSessionByDbId(r.id);
                const parts = session?.parts?.length ? session.parts : [filePath];
                let currentSizeBytes = null;
                for (const partPath of parts) {
                    const stat = await fs.stat(partPath).catch(() => null);
                    if (stat) currentSizeBytes = (currentSizeBytes || 0) + stat.size;
                }
                return {
                    ...r,
                    fileExists: true,
                    currentSizeBytes,
                    autoStopAt: session ? session.autoStopAt : null
                };
            }

            const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
            return { ...r, fileExists };
        }));
        res.json(withFileStatus.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)));
    } catch (err) {
        res.status(500).json({ error: 'Failed to list recordings' });
    }
});

/**
 * List currently active recording sessions
 * GET /api/recordings/active
 */
router.get('/active', (req, res) => {
    res.json(recordingSession.getAllActiveSessions());
});

/**
 * Download a recording
 * GET /api/recordings/:id/download
 */
router.get('/:id/download', async (req, res) => {
    const recording = await db.recordings.getById(req.params.id);
    if (!recording) {
        return res.status(404).json({ error: 'Recording not found' });
    }

    const filePath = path.join(recordingSession.RECORDINGS_DIR, recording.filename);
    res.download(filePath, `${recording.channelName || 'recording'}-${recording.id}.ts`, (err) => {
        if (err && !res.headersSent) {
            res.status(404).json({ error: 'Recording file not found' });
        }
    });
});

function isSessionActive(session) {
    return session.status === 'starting' || session.status === 'recording';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Pipe filePath[start..end] to res. Resolves true if the response closed
 * early (client disconnected or a read error), false on a clean finish.
 */
function pipeRange(filePath, start, end, res) {
    return new Promise((resolve) => {
        const stream = fsSync.createReadStream(filePath, { start, end });
        let failed = false;
        stream.on('data', (chunk) => {
            if (!res.write(chunk)) stream.pause();
        });
        res.on('drain', () => stream.resume());
        stream.on('end', () => resolve(failed));
        stream.on('error', () => { failed = true; resolve(true); });
    });
}

/**
 * Stream a still-in-progress recording live: play the finished part files
 * in order, tail the currently-active one as FFmpeg writes to it, and
 * follow a mid-watch restart (see RecordingSession's part-file restart
 * handling for why a recording can rotate to a new part at all) on to the
 * next part it creates - all transparent to the client, which just sees one
 * continuous response. No Range support - a recording that's still growing
 * has nothing meaningful to seek to yet, so every request gets a fresh
 * response starting from the beginning.
 */
async function streamActiveRecording(session, res) {
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-store');
    let closed = false;
    res.on('close', () => { closed = true; });

    let partIdx = 0;
    let totalSent = 0;

    while (!closed) {
        const partPath = session.parts[partIdx];

        if (!partPath) {
            if (isSessionActive(session)) { await sleep(500); continue; }
            break; // recording ended and this part never existed - nothing more coming
        }

        let offset = 0;
        let advance = false;

        while (!closed && !advance) {
            const stat = await fs.stat(partPath).catch(() => null);

            if (!stat) {
                // Vanished mid-read - only expected once finalizeRecording()
                // has joined every part into the final file. Pick up at the
                // same cumulative offset there (a byte-for-byte
                // concatenation of the parts in order), then stop - there's
                // nothing beyond the final file either way.
                if (isSessionActive(session)) { await sleep(500); continue; }
                const finalStat = await fs.stat(session.filePath).catch(() => null);
                if (finalStat && finalStat.size > totalSent) {
                    if (await pipeRange(session.filePath, totalSent, finalStat.size - 1, res)) closed = true;
                }
                closed = true;
                break;
            }

            if (stat.size > offset) {
                if (await pipeRange(partPath, offset, stat.size - 1, res)) { closed = true; break; }
                totalSent += stat.size - offset;
                offset = stat.size;
                continue; // recheck immediately - more may have arrived while sending
            }

            // Caught up to this part's current size - it's done growing once
            // a later part exists (a restart moved on) or the session
            // stopped entirely; otherwise FFmpeg is still writing it.
            if (session.parts.length > partIdx + 1 || !isSessionActive(session)) {
                advance = true;
            } else {
                await sleep(500);
            }
        }

        partIdx++;
    }

    if (!closed) res.end();
}

/**
 * Stream a recording for in-app playback (not a forced download). While
 * still actively recording, the data lives in part files that only get
 * joined into the final filename once the recording stops (see
 * RecordingSession) - so an in-progress recording is served live via
 * streamActiveRecording() instead of statting a file that doesn't exist yet.
 * Once finished, Range requests work via res.sendFile()'s built-in support,
 * same as any other static file Express serves, so seeking works and
 * playback can start before the whole file is fetched. Also what the
 * server's own probe/remux pipeline reads from when watching a recording
 * through WatchPage, exactly like it already does for a live channel's URL.
 * GET /api/recordings/:id/stream
 */
router.get('/:id/stream', async (req, res) => {
    const recording = await db.recordings.getById(req.params.id);
    if (!recording) {
        return res.status(404).json({ error: 'Recording not found' });
    }

    const session = recordingSession.getSessionByDbId(recording.id);
    if (session) {
        return streamActiveRecording(session, res);
    }

    const filePath = path.join(recordingSession.RECORDINGS_DIR, recording.filename);
    res.setHeader('Content-Type', 'video/mp2t');
    res.sendFile(filePath, (err) => {
        if (err && !res.headersSent) {
            res.status(404).json({ error: 'Recording file not found' });
        }
    });
});

/**
 * Quick ffprobe of just the video codec, so the HLS export below can pick
 * the right bitstream filter (see TranscodeSession.buildFFmpegArgs's 'copy'
 * branch) instead of guessing. Best-effort - callers fall back to 'unknown'
 * (which still works, just via a generic bitstream filter) rather than
 * failing the whole export over a probe hiccup.
 */
function probeVideoCodec(filePath, ffprobePath) {
    return new Promise((resolve, reject) => {
        const proc = spawn(ffprobePath, [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name',
            '-of', 'csv=p=0',
            filePath
        ]);
        let stdout = '';
        proc.stdout.on('data', (d) => { stdout += d; });
        proc.on('close', (code) => {
            if (code !== 0) return reject(new Error(`ffprobe exited with code ${code}`));
            resolve(stdout.trim().toLowerCase() || 'unknown');
        });
        proc.on('error', reject);
    });
}

/**
 * Serve a completed recording as an externally-consumable HLS playlist -
 * for pasting into a separate player app (a different IPTV client, VLC,
 * etc.) that hits this URL directly rather than going through NodeCast TV's
 * own Watch page. The raw file (served by /:id/stream and /:id/download) is
 * unprocessed MPEG-TS with no container-level duration index, joined
 * byte-for-byte from however many part files the recording produced - fine
 * for our own player once routed through the same stream-copy remux this
 * route uses (see WatchPage.js's recording-playback handling), but an
 * external player hitting the raw file directly gets none of that and hits
 * the exact same "stops partway / can't seek past a wrong duration" problem.
 * This lazily starts (or reuses) a stream-copy VOD transcode session against
 * the finished file and redirects to its playlist, so any external player
 * gets a real HLS .m3u8 instead.
 * GET /api/recordings/:id/hls.m3u8
 */
router.get('/:id/hls.m3u8', async (req, res) => {
    const recording = await db.recordings.getById(req.params.id);
    if (!recording) {
        return res.status(404).json({ error: 'Recording not found' });
    }
    if (recording.status === 'recording') {
        return res.status(409).json({ error: 'Recording is still in progress - the external link is only available once it finishes.' });
    }

    const filePath = path.join(recordingSession.RECORDINGS_DIR, recording.filename);
    const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
    if (!fileExists) {
        return res.status(404).json({ error: 'Recording file not found' });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
    const ffprobePath = req.app.locals.ffprobePath;
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);

    const videoCodec = ffprobePath
        ? await probeVideoCodec(filePath, ffprobePath).catch(() => 'unknown')
        : 'unknown';

    try {
        // Keyed by filePath (stable across requests for this recording) so a
        // second player re-hitting this same link mid-playback reuses the
        // already-running session instead of spawning a duplicate FFmpeg
        // process against the same file.
        const session = await transcodeSession.getOrCreateSession(filePath, {
            ffmpegPath,
            userAgent,
            videoMode: 'copy',
            sessionType: 'vod',
            videoCodec
        });
        await session.start(); // no-op if getOrCreateSession returned an already-running session

        const ready = await session.waitForPlaylist(15000);
        if (!ready) {
            return res.status(500).json({ error: 'Failed to prepare HLS playlist for this recording' });
        }
        res.redirect(`/api/transcode/${session.id}/stream.m3u8`);
    } catch (err) {
        console.error(`[Recordings] Failed to prepare HLS export for recording ${recording.id}:`, err);
        res.status(500).json({ error: 'Failed to prepare HLS playlist', details: err.message });
    }
});

/**
 * Delete a recording
 * DELETE /api/recordings/:id
 */
router.delete('/:id', async (req, res) => {
    const recording = await db.recordings.getById(req.params.id);
    if (!recording) {
        return res.status(404).json({ error: 'Recording not found' });
    }

    // Stop it first if still active
    const session = recordingSession.getSessionByDbId(recording.id);
    if (session) {
        await session.stop();
        recordingSession.removeSession(session.id);
    }

    const filePath = path.join(recordingSession.RECORDINGS_DIR, recording.filename);
    await fs.unlink(filePath).catch(() => {});
    await db.recordings.delete(req.params.id);

    res.json({ success: true });
});

module.exports = router;
