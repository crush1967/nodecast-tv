const express = require('express');
const router = express.Router();
const fs = require('fs/promises');
const path = require('path');
const db = require('../db');
const auth = require('../auth');
const recordingSession = require('../services/recordingSession');

/**
 * Xtream-compatible endpoints for recordings
 *
 * Lets a separate Xtream player app (e.g. on Apple TV) log in to NodeCast TV
 * with a normal NodeCast username/password and see finished recordings as
 * VOD "movies". Only recordings are exposed - live/series lists are empty.
 *
 * GET /player_api.php                         - login info + VOD listing actions
 * GET /movie/:username/:password/:file        - play a recording (<id>.ts)
 * GET /xmltv.php                              - empty guide (apps fetch it on setup)
 * GET /get.php                                - M3U playlist of recordings
 */

const RECORDINGS_CATEGORY_ID = '1';

// bcrypt is deliberately slow and these apps re-send credentials on every
// request, so remember a successful check for a few minutes.
const credentialCache = new Map();
const CREDENTIAL_CACHE_TTL_MS = 5 * 60 * 1000;

async function checkCredentials(username, password) {
    if (!username || !password) return null;
    const key = `${username}\n${password}`;
    const cached = credentialCache.get(key);
    if (cached && Date.now() - cached.timestamp < CREDENTIAL_CACHE_TTL_MS) {
        return cached.user;
    }

    const user = await db.users.getByUsername(username);
    if (!user || !user.passwordHash) return null;
    if (!(await auth.verifyPassword(password, user.passwordHash))) return null;

    credentialCache.set(key, { user, timestamp: Date.now() });
    return user;
}

function unixSeconds(iso) {
    return String(Math.floor(new Date(iso).getTime() / 1000));
}

function recordingTitle(r) {
    const started = new Date(r.startedAt);
    const date = started.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const time = started.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `${r.channelName || 'Recording'} - ${date} ${time}`;
}

// Finished recordings whose file is still on disk, newest first
async function getPlayableRecordings() {
    const all = await db.recordings.getAll();
    const finished = all.filter(r => r.status === 'completed' && r.filename);
    const withFile = await Promise.all(finished.map(async r => {
        const filePath = path.join(recordingSession.RECORDINGS_DIR, r.filename);
        const exists = await fs.access(filePath).then(() => true).catch(() => false);
        return exists ? r : null;
    }));
    return withFile
        .filter(Boolean)
        .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

function toVodStream(r, index) {
    return {
        num: index + 1,
        name: recordingTitle(r),
        stream_type: 'movie',
        stream_id: r.id,
        stream_icon: '',
        rating: '',
        rating_5based: 0,
        added: unixSeconds(r.startedAt),
        category_id: RECORDINGS_CATEGORY_ID,
        category_ids: [parseInt(RECORDINGS_CATEGORY_ID)],
        container_extension: 'ts',
        custom_sid: '',
        direct_source: ''
    };
}

function baseUrl(req) {
    return `${req.protocol}://${req.get('host')}`;
}

function loginInfo(req, username, password) {
    const host = req.get('host') || '';
    const [hostname, port] = host.split(':');
    const now = new Date();
    return {
        user_info: {
            username,
            password,
            message: '',
            auth: 1,
            status: 'Active',
            exp_date: null,
            is_trial: '0',
            active_cons: '0',
            created_at: unixSeconds(now),
            max_connections: '5',
            allowed_output_formats: ['ts']
        },
        server_info: {
            url: hostname,
            port: port || (req.protocol === 'https' ? '443' : '80'),
            https_port: req.protocol === 'https' ? (port || '443') : '',
            server_protocol: req.protocol,
            rtmp_port: '',
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            timestamp_now: Math.floor(now.getTime() / 1000),
            time_now: now.toISOString().replace('T', ' ').slice(0, 19)
        }
    };
}

router.get('/player_api.php', async (req, res) => {
    try {
        const { username, password, action } = req.query;
        const user = await checkCredentials(username, password);
        if (!user) {
            return res.json({ user_info: { auth: 0 } });
        }

        switch (action) {
            case undefined:
            case '':
                return res.json(loginInfo(req, username, password));

            case 'get_vod_categories':
                return res.json([{ category_id: RECORDINGS_CATEGORY_ID, category_name: 'Recordings', parent_id: 0 }]);

            case 'get_vod_streams': {
                if (req.query.category_id && req.query.category_id !== RECORDINGS_CATEGORY_ID) {
                    return res.json([]);
                }
                const recordings = await getPlayableRecordings();
                return res.json(recordings.map(toVodStream));
            }

            case 'get_vod_info': {
                const recording = (await getPlayableRecordings())
                    .find(r => r.id === parseInt(req.query.vod_id));
                if (!recording) return res.json({ info: [], movie_data: [] });

                const durationSecs = recording.stoppedAt
                    ? Math.max(0, Math.round((new Date(recording.stoppedAt) - new Date(recording.startedAt)) / 1000))
                    : 0;
                const hh = String(Math.floor(durationSecs / 3600)).padStart(2, '0');
                const mm = String(Math.floor((durationSecs % 3600) / 60)).padStart(2, '0');
                const ss = String(durationSecs % 60).padStart(2, '0');

                return res.json({
                    info: {
                        name: recordingTitle(recording),
                        plot: `Recorded from ${recording.channelName || 'unknown channel'}`,
                        releasedate: recording.startedAt.slice(0, 10),
                        duration_secs: durationSecs,
                        duration: `${hh}:${mm}:${ss}`,
                        movie_image: '',
                        cover_big: ''
                    },
                    movie_data: {
                        stream_id: recording.id,
                        name: recordingTitle(recording),
                        added: unixSeconds(recording.startedAt),
                        category_id: RECORDINGS_CATEGORY_ID,
                        container_extension: 'ts',
                        custom_sid: '',
                        direct_source: ''
                    }
                });
            }

            case 'get_live_categories':
            case 'get_live_streams':
            case 'get_series_categories':
            case 'get_series':
                return res.json([]);

            case 'get_series_info':
                return res.json({ seasons: [], info: {}, episodes: {} });

            case 'get_short_epg':
            case 'get_simple_data_table':
                return res.json({ epg_listings: [] });

            default:
                return res.json([]);
        }
    } catch (err) {
        console.error('[XtreamServer] player_api error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/movie/:username/:password/:file', async (req, res) => {
    const user = await checkCredentials(req.params.username, req.params.password);
    if (!user) return res.status(401).end();

    const id = parseInt(req.params.file);
    const recording = await db.recordings.getById(id);
    if (!recording || recording.status !== 'completed') return res.status(404).end();

    const filePath = path.join(recordingSession.RECORDINGS_DIR, recording.filename);
    res.setHeader('Content-Type', 'video/mp2t');
    res.sendFile(filePath, (err) => {
        if (err && !res.headersSent) res.status(404).end();
    });
});

router.get('/xmltv.php', async (req, res) => {
    const user = await checkCredentials(req.query.username, req.query.password);
    if (!user) return res.status(401).end();
    res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="NodeCast TV"></tv>\n');
});

router.get('/get.php', async (req, res) => {
    const { username, password } = req.query;
    const user = await checkCredentials(username, password);
    if (!user) return res.status(401).end();

    const recordings = await getPlayableRecordings();
    const base = baseUrl(req);
    const lines = ['#EXTM3U'];
    for (const r of recordings) {
        const title = recordingTitle(r).replace(/,/g, ' ');
        lines.push(`#EXTINF:-1 tvg-id="" tvg-name="${title}" group-title="Recordings",${title}`);
        lines.push(`${base}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${r.id}.ts`);
    }
    res.type('audio/x-mpegurl').send(lines.join('\n') + '\n');
});

module.exports = router;
