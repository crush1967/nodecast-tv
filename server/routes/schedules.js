const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../auth');
const recordingSession = require('../services/recordingSession');

/**
 * Scheduled Recording Routes
 *
 * POST   /api/schedules      - Create a scheduled recording
 * GET    /api/schedules      - List all schedules
 * DELETE /api/schedules/:id  - Cancel a schedule (stops the recording first if already running)
 */

router.use((req, res, next) => {
    const headerToken = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null;
    const token = headerToken || req.query.token;
    const payload = token && auth.verifyToken(token);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    req.user = payload;
    next();
});

/**
 * Create a scheduled recording
 * POST /api/schedules
 * Body: { channelName, sourceId?, streamId?, url?, startAt, endAt }
 */
router.post('/', async (req, res) => {
    const { channelName, sourceId, streamId, url, startAt, endAt } = req.body;

    if (!channelName || !startAt || !endAt) {
        return res.status(400).json({ error: 'channelName, startAt, and endAt are required' });
    }
    if (!(sourceId != null && streamId != null) && !url) {
        return res.status(400).json({ error: 'Either sourceId+streamId or url is required' });
    }

    const start = new Date(startAt).getTime();
    const end = new Date(endAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return res.status(400).json({ error: 'Invalid startAt/endAt' });
    }
    if (end <= start) {
        return res.status(400).json({ error: 'endAt must be after startAt' });
    }
    if (end <= Date.now()) {
        return res.status(400).json({ error: 'endAt must be in the future' });
    }

    const settings = await db.settings.get();
    const maxHours = settings.maxRecordingHours || 4;
    if (end - start > maxHours * 60 * 60 * 1000) {
        return res.status(400).json({ error: `A single recording can't be scheduled for more than ${maxHours} hours` });
    }

    const schedule = await db.schedules.create({ channelName, sourceId, streamId, url, startAt, endAt });
    res.json(schedule);
});

/**
 * List all schedules
 * GET /api/schedules
 */
router.get('/', async (req, res) => {
    const all = await db.schedules.getAll();
    res.json(all.sort((a, b) => new Date(b.startAt) - new Date(a.startAt)));
});

/**
 * Cancel/delete a schedule
 * DELETE /api/schedules/:id
 */
router.delete('/:id', async (req, res) => {
    const schedule = await db.schedules.getById(req.params.id);
    if (!schedule) {
        return res.status(404).json({ error: 'Schedule not found' });
    }

    if (schedule.status === 'recording' && schedule.recordingId) {
        const session = recordingSession.getSessionByDbId(schedule.recordingId);
        if (session) {
            await session.stop();
            await recordingSession.finalizeRecording(session);
        }
    }

    await db.schedules.delete(req.params.id);
    res.json({ success: true });
});

/**
 * Add more time to a schedule - works whether it hasn't started yet
 * (just pushes endAt back) or is actively recording (also reschedules the
 * live FFmpeg process's auto-stop timer, no restart needed).
 * POST /api/schedules/:id/extend
 * Body: { addMinutes: number }
 */
router.post('/:id/extend', async (req, res) => {
    const mins = Number(req.body.addMinutes);
    if (!mins || mins <= 0) {
        return res.status(400).json({ error: 'addMinutes must be a positive number' });
    }

    const schedule = await db.schedules.getById(req.params.id);
    if (!schedule) {
        return res.status(404).json({ error: 'Schedule not found' });
    }
    if (schedule.status !== 'scheduled' && schedule.status !== 'recording') {
        return res.status(400).json({ error: 'Only upcoming or in-progress recordings can be extended' });
    }

    const requestedEndMs = new Date(schedule.endAt).getTime() + mins * 60000;
    let finalEndMs = requestedEndMs;

    if (schedule.status === 'recording' && schedule.recordingId) {
        const session = recordingSession.getSessionByDbId(schedule.recordingId);
        if (session) {
            session.setAutoStopAt(requestedEndMs); // clamps internally to the session's hard cap
            finalEndMs = session.autoStopAt; // reflect whatever it actually landed on
        }
    } else {
        // Not started yet - no live session to clamp against, so enforce the
        // same hard cap independently, relative to the schedule's own start.
        const settings = await db.settings.get();
        const maxDurationMs = (settings.maxRecordingHours || 4) * 60 * 60 * 1000;
        const hardMaxMs = new Date(schedule.startAt).getTime() + maxDurationMs;
        finalEndMs = Math.min(requestedEndMs, hardMaxMs);
    }

    const updated = await db.schedules.update(schedule.id, { endAt: new Date(finalEndMs).toISOString() });
    res.json({ ...updated, capped: finalEndMs < requestedEndMs });
});

module.exports = router;
