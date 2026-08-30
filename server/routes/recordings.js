const express = require('express');
const router = express.Router();
const fs = require('fs/promises');
const path = require('path');
const db = require('../db');
const auth = require('../auth');
const recordingSession = require('../services/recordingSession');
const diskGuard = require('../services/diskGuard');

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
                // estimated final size while it's still in progress.
                const stat = await fs.stat(filePath).catch(() => null);
                const session = recordingSession.getSessionByDbId(r.id);
                return {
                    ...r,
                    fileExists: true,
                    currentSizeBytes: stat ? stat.size : null,
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

/**
 * Stream a recording for in-app playback (not a forced download) - Range
 * requests work via res.sendFile()'s built-in support, same as any other
 * static file Express serves, so seeking works and playback can start
 * before the whole file is fetched. Also what the server's own probe/remux
 * pipeline reads from when watching a recording through WatchPage, exactly
 * like it already does for a live channel's URL.
 * GET /api/recordings/:id/stream
 */
router.get('/:id/stream', async (req, res) => {
    const recording = await db.recordings.getById(req.params.id);
    if (!recording) {
        return res.status(404).json({ error: 'Recording not found' });
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
