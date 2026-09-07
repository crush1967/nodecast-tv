/**
 * Recordings Library Page
 * Three states, kept visually distinct: Recording Now (active, whether
 * started manually or by a fired schedule), Scheduled (upcoming/missed),
 * and Recorded (finished history, with Download/Delete).
 */
class RecordingsPage {
    constructor(app) {
        this.app = app;
        this.pollInterval = null;
        this.favoriteChannels = [];
    }

    async init() {
        // Nothing to preload
    }

    async show() {
        // The form is built once and never touched again while this page stays
        // open - only the three list regions get replaced on each poll.
        // Rebuilding the whole page (including the form) every 5s used to
        // destroy the datetime inputs mid-edit, losing whatever was typed.
        await this.renderShell();
        await this.loadLists();
        this.pollInterval = setInterval(() => this.loadLists(), 5000);
    }

    hide() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    formatBytes(bytes) {
        if (!bytes && bytes !== 0) return '—';
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let i = 0;
        while (size >= 1024 && i < units.length - 1) {
            size /= 1024;
            i++;
        }
        return `${size.toFixed(1)} ${units[i]}`;
    }

    formatDuration(startedAt, stoppedAt) {
        const start = new Date(startedAt).getTime();
        const end = stoppedAt ? new Date(stoppedAt).getTime() : Date.now();
        const totalSec = Math.max(0, Math.floor((end - start) / 1000));
        const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
        const secs = String(totalSec % 60).padStart(2, '0');
        return `${mins}:${secs}`;
    }

    /**
     * Extrapolate an in-progress recording's current growth rate out to its
     * planned stop time (autoStopAt - every recording has one, since the
     * server always applies at least the hard safety cap even if no specific
     * duration was requested). Needs a few seconds of real data first, or the
     * rate is too noisy to be a useful estimate.
     */
    estimateFinalSizeLabel(r) {
        if (r.currentSizeBytes == null || !r.autoStopAt) return '';

        const elapsedSec = (Date.now() - new Date(r.startedAt).getTime()) / 1000;
        if (elapsedSec < 10) return '';

        const totalPlannedSec = (r.autoStopAt - new Date(r.startedAt).getTime()) / 1000;
        const bytesPerSec = r.currentSizeBytes / elapsedSec;
        const estimatedFinalBytes = bytesPerSec * totalPlannedSec;

        return `<span>~${this.formatBytes(estimatedFinalBytes)} estimated total</span>`;
    }

    /**
     * Favorite channels resolved to display info, same lookup HomePage.js
     * uses for its "Favorite Channels" row: match favorites against the
     * already-loaded channel list by sourceId + the channel's composite id
     * (ChannelList.js stores favorites keyed by channel.id, e.g.
     * "xtream_2_391434" - not the raw streamId).
     */
    async getFavoriteChannels() {
        const favorites = await API.request('GET', '/favorites?itemType=channel');
        if (!favorites || favorites.length === 0) return [];

        const channelList = this.app.channelList;
        if (!channelList.channels || channelList.channels.length === 0) {
            await channelList.loadSources();
            await channelList.loadChannels();
        }

        const channels = [];
        for (const fav of favorites) {
            const channel = channelList.channels.find(ch =>
                String(ch.sourceId) === String(fav.source_id) &&
                String(ch.id) === String(fav.item_id)
            );
            if (channel) channels.push(channel);
        }
        return channels;
    }

    /**
     * Build the page shell ONCE: header, the schedule form (wired up here,
     * never re-rendered), and empty containers for the three lists that get
     * refreshed on a poll.
     */
    async renderShell() {
        const container = document.getElementById('page-recordings');
        if (!container) return;

        this.favoriteChannels = await this.getFavoriteChannels().catch(() => []);

        container.innerHTML = `
            <div class="recordings-header">
                <h2>Recordings <span id="recordings-version" style="font-size:0.6em;opacity:0.5;font-weight:normal;"></span></h2>
            </div>

            <section class="schedule-panel">
                <h3 class="panel-title">Schedule a Recording</h3>
                ${this.favoriteChannels.length === 0
                    ? '<div class="loading-state">Add channels to favorites from Live TV to schedule recordings.</div>'
                    : `
                    <div class="schedule-form">
                        <div class="schedule-field schedule-field-channel">
                            <label for="schedule-channel">Channel</label>
                            <select id="schedule-channel">
                                ${this.favoriteChannels.map(ch => `<option value="${ch.sourceId}|${ch.streamId ?? ch.id}">${this.escapeHtml(ch.name || ch.tvgName || 'Unknown Channel')}</option>`).join('')}
                            </select>
                        </div>
                        <div class="schedule-field">
                            <label for="schedule-start">Start</label>
                            <input type="datetime-local" id="schedule-start">
                        </div>
                        <div class="schedule-field">
                            <label for="schedule-end">End</label>
                            <input type="datetime-local" id="schedule-end">
                        </div>
                        <button class="btn-primary schedule-submit-btn" id="btn-schedule-create">Schedule Recording</button>
                    </div>
                    <div class="schedule-quick-toolbar">
                        <span class="schedule-quick-label">Quick fill</span>
                        <button type="button" class="btn-quick" id="btn-start-now">Start Now</button>
                        <span class="schedule-quick-divider"></span>
                        <button type="button" class="btn-quick" data-mins="30">+30m</button>
                        <button type="button" class="btn-quick" data-mins="60">+1h</button>
                        <button type="button" class="btn-quick" data-mins="120">+2h</button>
                        <button type="button" class="btn-quick" data-mins="180">+3h</button>
                    </div>
                    <div class="schedule-error hidden" id="schedule-error"></div>
                `}
            </section>

            <section class="recordings-section" id="recording-now-section"></section>
            <section class="recordings-section" id="scheduled-section"></section>
            <section class="recordings-section" id="recorded-section"></section>
        `;

        this.wireScheduleForm();

        // Visible on-page version marker, so reloading this exact page is
        // enough to confirm which build is actually running - no separate
        // URL to visit or dev tools needed.
        API.request('GET', '/version').then(v => {
            const el = document.getElementById('recordings-version');
            if (el && v?.version) el.textContent = `v${v.version}`;
        }).catch(() => {});
    }

    async loadLists() {
        try {
            const [recordings, schedules] = await Promise.all([
                API.recordings.getAll(),
                API.schedules.getAll()
            ]);

            const recordingNow = recordings.filter(r => r.status === 'recording');
            const recordedHistory = recordings.filter(r => r.status !== 'recording');
            // Once a schedule fires it's represented by its linked recording (now
            // in recordingNow / recordedHistory) - only show schedules that never
            // started yet, or that never got the chance to (missed).
            const scheduledUpcoming = schedules.filter(s => s.status === 'scheduled' || s.status === 'missed');
            // Cross-reference so an active recording that came from a fired
            // schedule can still offer "add more time" (extend targets the
            // schedule's id, not the recording's - a manual recording with no
            // linked schedule has nothing to extend).
            const scheduleByRecordingId = new Map(
                schedules.filter(s => s.status === 'recording' && s.recordingId).map(s => [s.recordingId, s])
            );

            this.renderRecordingNow(recordingNow, scheduleByRecordingId);
            this.renderScheduledList(scheduledUpcoming);
            this.renderRecordedList(recordedHistory);
        } catch (err) {
            console.error('[Recordings] Failed to load:', err);
        }
    }

    /** Shared row markup for all three lists. */
    buildRow({ id, channelName, metaHtml, actionsHtml, extraClass = '' }) {
        return `
            <div class="recording-row ${extraClass}" data-id="${id}">
                <div class="recording-info">
                    <div class="recording-channel">${this.escapeHtml(channelName || 'Unknown Channel')}</div>
                    <div class="recording-meta">${metaHtml}</div>
                </div>
                <div class="recording-actions">${actionsHtml}</div>
            </div>
        `;
    }

    /** Small +15m/+30m quick-extend buttons, targeting a schedule id. */
    buildExtendButtons(scheduleId) {
        return `
            <div class="row-extend">
                <button type="button" class="btn-quick btn-extend" data-schedule-id="${scheduleId}" data-mins="15">+15m</button>
                <button type="button" class="btn-quick btn-extend" data-schedule-id="${scheduleId}" data-mins="30">+30m</button>
            </div>
        `;
    }

    /** Watch button, shared by the Recording Now and Recorded lists - the
     * stream endpoint transparently serves the live-growing part file(s)
     * while a recording is still active, so this works identically either
     * way with no extra state needed here. */
    wireWatchButtons(root) {
        root.querySelectorAll('.btn-watch-recording').forEach(btn => {
            btn.addEventListener('click', () => {
                const streamUrl = API.recordings.getStreamUrl(btn.dataset.id);
                window.app.pages.watch.play({
                    type: 'recording',
                    title: btn.dataset.channel || 'Recording',
                    subtitle: new Date(btn.dataset.started).toLocaleString(),
                    containerExtension: 'ts'
                }, streamUrl);
            });
        });
    }

    wireExtendButtons(root) {
        root.querySelectorAll('.btn-extend').forEach(btn => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                try {
                    const result = await API.schedules.extend(btn.dataset.scheduleId, parseInt(btn.dataset.mins, 10));
                    if (result.capped) {
                        alert(`Only extended part of that - a single recording is capped at a maximum length for safety. New end time: ${new Date(result.endAt).toLocaleTimeString()}.`);
                    }
                    await this.loadLists();
                } catch (err) {
                    alert('Failed to add time: ' + err.message);
                    btn.disabled = false;
                }
            });
        });
    }

    renderRecordingNow(recordings, scheduleByRecordingId) {
        const section = document.getElementById('recording-now-section');
        if (!section) return;

        if (recordings.length === 0) {
            section.innerHTML = '';
            return;
        }

        const rows = recordings.map(r => {
            const schedule = scheduleByRecordingId.get(r.id);
            return this.buildRow({
                id: r.id,
                channelName: r.channelName,
                extraClass: 'recording-row-active',
                metaHtml: `
                    <span class="recording-status recording"><span class="recording-dot"></span>Recording</span>
                    <span>Started ${new Date(r.startedAt).toLocaleTimeString()}</span>
                    <span>${this.formatDuration(r.startedAt, null)} elapsed</span>
                    ${schedule ? `<span>Ends ${new Date(schedule.endAt).toLocaleTimeString()}</span>` : ''}
                    ${r.currentSizeBytes != null ? `<span>${this.formatBytes(r.currentSizeBytes)} so far</span>` : ''}
                    ${this.estimateFinalSizeLabel(r)}
                `,
                actionsHtml: `
                    <button class="btn-primary btn-watch-recording" data-id="${r.id}" data-channel="${this.escapeHtml(r.channelName || '')}" data-started="${r.startedAt}">Watch</button>
                    ${schedule ? this.buildExtendButtons(schedule.id) : ''}
                    <button class="btn-secondary btn-stop-recording" data-id="${r.id}">Stop</button>
                `
            });
        }).join('');

        section.innerHTML = `
            <div class="section-title section-title-live">
                <span class="recording-dot"></span> Recording Now
            </div>
            <div class="recordings-list">${rows}</div>
        `;

        this.wireExtendButtons(section);
        this.wireWatchButtons(section);

        section.querySelectorAll('.btn-stop-recording').forEach(btn => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                try {
                    await API.recordings.stop(btn.dataset.id);
                    await this.loadLists();
                } catch (err) {
                    alert('Failed to stop recording: ' + err.message);
                    btn.disabled = false;
                }
            });
        });
    }

    renderScheduledList(schedules) {
        const section = document.getElementById('scheduled-section');
        if (!section) return;

        if (schedules.length === 0) {
            section.innerHTML = '';
            return;
        }

        const rows = schedules.map(s => {
            const isMissed = s.status === 'missed';
            return this.buildRow({
                id: s.id,
                channelName: s.channelName,
                metaHtml: `
                    <span class="recording-status ${isMissed ? 'missed' : 'scheduled'}">${isMissed ? 'Missed' : 'Scheduled'}</span>
                    <span>${new Date(s.startAt).toLocaleString()} - ${new Date(s.endAt).toLocaleTimeString()}</span>
                `,
                actionsHtml: isMissed
                    ? `<button class="btn-danger btn-cancel-schedule" data-id="${s.id}">Dismiss</button>`
                    : `
                        ${this.buildExtendButtons(s.id)}
                        <button class="btn-danger btn-cancel-schedule" data-id="${s.id}">Cancel</button>
                    `
            });
        }).join('');

        section.innerHTML = `
            <div class="section-title">Scheduled</div>
            <div class="recordings-list">${rows}</div>
        `;

        this.wireExtendButtons(section);

        section.querySelectorAll('.btn-cancel-schedule').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Remove this scheduled recording?')) return;
                btn.disabled = true;
                try {
                    await API.schedules.delete(btn.dataset.id);
                    await this.loadLists();
                } catch (err) {
                    alert('Failed to remove: ' + err.message);
                    btn.disabled = false;
                }
            });
        });
    }

    renderRecordedList(recordings) {
        const section = document.getElementById('recorded-section');
        if (!section) return;

        if (recordings.length === 0) {
            section.innerHTML = `
                <div class="section-title">Recorded</div>
                <div class="loading-state">No recordings yet. Start one from the overflow menu while watching Live TV, or schedule one above.</div>
            `;
            return;
        }

        const rows = recordings.map(r => {
            const isError = r.status === 'error';
            const isMissing = r.fileExists === false;
            const statusClass = isMissing ? 'missing' : (isError ? 'error' : 'completed');
            const statusLabel = isMissing ? 'File Missing' : (isError ? 'Error' : 'Completed');

            return this.buildRow({
                id: r.id,
                channelName: r.channelName,
                metaHtml: `
                    <span class="recording-status ${statusClass}">${statusLabel}</span>
                    <span>${new Date(r.startedAt).toLocaleString()}</span>
                    <span>${this.formatDuration(r.startedAt, r.stoppedAt)}</span>
                    <span>${this.formatBytes(r.sizeBytes)}</span>
                `,
                actionsHtml: `
                    ${!isError && !isMissing ? `<button class="btn-primary btn-watch-recording" data-id="${r.id}" data-channel="${this.escapeHtml(r.channelName || '')}" data-started="${r.startedAt}">Watch</button>` : ''}
                    ${!isError && !isMissing ? `<a class="btn-secondary" href="${API.recordings.getDownloadUrl(r.id)}">Download</a>` : ''}
                    <button class="btn-danger btn-delete-recording" data-id="${r.id}">${isMissing ? 'Remove' : 'Delete'}</button>
                `
            });
        }).join('');

        section.innerHTML = `
            <div class="section-title">Recorded</div>
            <div class="recordings-list">${rows}</div>
        `;

        this.wireWatchButtons(section);

        section.querySelectorAll('.btn-delete-recording').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this recording? This cannot be undone.')) return;
                btn.disabled = true;
                try {
                    await API.recordings.delete(btn.dataset.id);
                    await this.loadLists();
                } catch (err) {
                    alert('Failed to delete recording: ' + err.message);
                    btn.disabled = false;
                }
            });
        });
    }

    /**
     * Format a Date as a datetime-local input expects: local time (not UTC),
     * "YYYY-MM-DDTHH:mm".
     */
    toDatetimeLocalValue(date) {
        const pad = n => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    wireScheduleForm() {
        const startInput = document.getElementById('schedule-start');
        const endInput = document.getElementById('schedule-end');
        if (!startInput || !endInput) return;

        // Default to a real start/end pair (now / now+1h) rather than leaving
        // the fields blank - iOS Safari renders an empty datetime-local as a
        // literally blank box (no placeholder segments, no icon), which reads
        // as broken. A pre-filled value sidesteps that entirely.
        const now = new Date();
        startInput.value = this.toDatetimeLocalValue(now);
        endInput.value = this.toDatetimeLocalValue(new Date(now.getTime() + 60 * 60000));

        document.getElementById('btn-start-now')?.addEventListener('click', () => {
            startInput.value = this.toDatetimeLocalValue(new Date());
        });

        document.querySelectorAll('.btn-quick[data-mins]').forEach(quickBtn => {
            quickBtn.addEventListener('click', () => {
                // Base off Start if it's set, otherwise off now (and fill Start too,
                // so "+1h" alone is enough to get a valid start/end pair).
                if (!startInput.value) startInput.value = this.toDatetimeLocalValue(new Date());
                const base = new Date(startInput.value);
                const mins = parseInt(quickBtn.dataset.mins, 10);
                endInput.value = this.toDatetimeLocalValue(new Date(base.getTime() + mins * 60000));
            });
        });

        const btn = document.getElementById('btn-schedule-create');
        if (!btn) return;

        btn.addEventListener('click', async () => {
            const errorEl = document.getElementById('schedule-error');
            errorEl?.classList.add('hidden');

            const channelSelect = document.getElementById('schedule-channel');

            const [sourceId, streamId] = (channelSelect?.value || '').split('|');
            const channel = this.favoriteChannels.find(ch =>
                String(ch.sourceId) === sourceId && String(ch.streamId ?? ch.id) === streamId
            );

            if (!channel || !startInput.value || !endInput.value) {
                if (errorEl) { errorEl.textContent = 'Pick a channel, start time, and end time.'; errorEl.classList.remove('hidden'); }
                return;
            }

            const payload = {
                channelName: channel.name || channel.tvgName || 'Unknown Channel',
                startAt: new Date(startInput.value).toISOString(),
                endAt: new Date(endInput.value).toISOString()
            };
            if (channel.sourceType === 'xtream') {
                payload.sourceId = channel.sourceId;
                payload.streamId = channel.streamId ?? channel.id;
            } else {
                payload.url = channel.url;
            }

            btn.disabled = true;
            try {
                await API.schedules.create(payload);
                startInput.value = '';
                endInput.value = '';
                await this.loadLists();
            } catch (err) {
                if (errorEl) { errorEl.textContent = err.message; errorEl.classList.remove('hidden'); }
            } finally {
                btn.disabled = false;
            }
        });
    }

    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}

window.RecordingsPage = RecordingsPage;
