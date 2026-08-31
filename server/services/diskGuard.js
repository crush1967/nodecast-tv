/**
 * Recording Safety Guard
 *
 * Recordings write large, unbounded files - nothing else in this app limits
 * how much disk space they can consume. Three independent, deliberately
 * redundant layers:
 *   1. A hard per-recording max DURATION (recordingSession.js) - no recording
 *      runs forever even if nothing requested a specific length.
 *   2. A per-recording max SIZE sanity check (this file) - catches a recording
 *      that's within its time budget but growing far faster than any real
 *      stream should (corrupt input, runaway writes), independent of #1.
 *   3. A global free-DISK-SPACE floor (this file) - force-stops every active
 *      recording the moment free space actually gets low, regardless of which
 *      recording (or what else entirely) is consuming it. This is the last
 *      resort and doesn't try to be clever about which one caused it.
 * Also refuses to START a new recording at all if free space is already low.
 */

const fs = require('fs');
const recordingSession = require('./recordingSession');

const CHECK_INTERVAL_MS = 30 * 1000;
const GB = 1024 * 1024 * 1024;

// Generous ceiling - well above any real single IPTV stream (even 4K tops
// out well under this) - so this only ever fires on genuinely abnormal growth,
// not normal bitrate variance.
const MAX_BYTES_PER_SECOND = (25 * 1000 * 1000) / 8; // 25 Mbps

async function getFreeSpaceBytes() {
    const stats = await fs.promises.statfs(recordingSession.RECORDINGS_DIR);
    return stats.bavail * stats.bsize;
}

async function hasEnoughSpace(minFreeGB) {
    try {
        const free = await getFreeSpaceBytes();
        return free >= minFreeGB * GB;
    } catch (err) {
        // If we can't even check, fail closed - don't start a recording blind.
        console.error('[DiskGuard] Failed to check free space:', err.message);
        return false;
    }
}

/**
 * Stop every active recording immediately. Used when free space has actually
 * dropped below the minimum - at that point we don't try to be clever about
 * which recording to keep, we just stop the bleeding.
 */
async function stopAllRecordings(reason) {
    const active = recordingSession.getAllActiveSessions();
    for (const entry of active) {
        const session = recordingSession.getSessionByDbId(entry.id);
        if (!session) continue;
        console.error(`[DiskGuard] Force-stopping recording ${entry.id} ("${entry.channelName}"): ${reason}`);
        await session.stop();
        await recordingSession.finalizeRecording(session);
    }
    return active.length;
}

async function checkFreeSpace(minFreeGB) {
    let free;
    try {
        free = await getFreeSpaceBytes();
    } catch (err) {
        console.error('[DiskGuard] Failed to check free space:', err.message);
        return;
    }

    if (free < minFreeGB * GB) {
        const stopped = await stopAllRecordings(
            `free space ${(free / GB).toFixed(2)}GB is below the ${minFreeGB}GB minimum`
        );
        if (stopped > 0) {
            console.error(`[DiskGuard] Stopped ${stopped} recording(s) to protect disk space.`);
        }
    }
}

/**
 * Per-recording sanity check: is this file bigger than any real stream could
 * plausibly have produced in the time it's been recording? If so, something
 * is wrong regardless of how much total disk space remains - stop it.
 */
async function checkRecordingSizes() {
    const active = recordingSession.getAllActiveSessions();
    for (const entry of active) {
        const session = recordingSession.getSessionByDbId(entry.id);
        if (!session) continue;

        // While actively recording, the data lives in part files (see
        // RecordingSession - a mid-recording restart after a connection drop
        // writes a new part rather than resuming session.filePath directly),
        // which only gets joined together once the recording actually stops.
        // Summing every part's current size gives the true total written so
        // far either way.
        const parts = session.parts && session.parts.length ? session.parts : [session.filePath];
        let totalSize = 0;
        let anyFound = false;
        for (const partPath of parts) {
            try {
                const partStat = await fs.promises.stat(partPath);
                totalSize += partStat.size;
                anyFound = true;
            } catch {
                // This part not written yet (or already joined/removed) - skip it.
            }
        }
        if (!anyFound) continue; // Nothing written yet, nothing to check

        const elapsedSeconds = (Date.now() - session.startedAt) / 1000;
        const maxExpectedBytes = elapsedSeconds * MAX_BYTES_PER_SECOND;

        if (totalSize > maxExpectedBytes) {
            const actualMbps = ((totalSize * 8) / elapsedSeconds / 1e6).toFixed(1);
            console.error(
                `[DiskGuard] Recording ${entry.id} ("${entry.channelName}") is growing abnormally fast ` +
                `(~${actualMbps} Mbps, expected under 25) - stopping it.`
            );
            await session.stop();
            await recordingSession.finalizeRecording(session);
        }
    }
}

async function checkAndEnforce(minFreeGB) {
    await checkFreeSpace(minFreeGB);
    await checkRecordingSizes();
}

let interval = null;

/**
 * @param {() => Promise<number>} getMinFreeGB - resolved fresh on every check
 * so a settings change takes effect without a restart.
 */
function startDiskGuard(getMinFreeGB) {
    if (interval) return;
    interval = setInterval(async () => {
        try {
            const minFreeGB = await getMinFreeGB();
            await checkAndEnforce(minFreeGB);
        } catch (err) {
            console.error('[DiskGuard] Check failed:', err.message);
        }
    }, CHECK_INTERVAL_MS);
    interval.unref(); // Don't prevent process exit
    console.log(`[DiskGuard] Started - checking free disk space and recording growth every ${CHECK_INTERVAL_MS / 1000}s`);
}

module.exports = { getFreeSpaceBytes, hasEnoughSpace, stopAllRecordings, checkAndEnforce, startDiskGuard };
