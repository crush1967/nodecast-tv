/**
 * Video Player Component
 * Handles HLS video playback with custom controls
 */

// Check if device is mobile
function isMobile() {
    return /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

class VideoPlayer {
    // Manual quality-override presets for the "Lower Quality" retry (see the
    // long comment in play() for why this exists at all - this provider has
    // no adaptive bitrate ladder, so there's nothing to fall back to except
    // re-encoding server-side). maxBitrateKbps enforces a hard VBV ceiling
    // (see addSoftwareEncoderArgs) - CRF alone lets bitrate float with scene
    // complexity, which defeats the point for the sports-heavy channels this
    // is most likely to get used on.
    static QUALITY_OVERRIDE_PRESETS = {
        '720p': { maxResolution: '720p', quality: 'medium', maxBitrateKbps: 2500 },
        '480p': { maxResolution: '480p', quality: 'low', maxBitrateKbps: 1200 }
    };

    constructor() {
        this.video = document.getElementById('video-player');

        // iOS: ensure inline playback (not fullscreen by default)
        if (this.video) {
            this.video.setAttribute('playsinline', '');
            this.video.setAttribute('webkit-playsinline', '');
        }

        this.container = document.querySelector('.video-container');
        this.overlay = document.getElementById('player-overlay');
        this.nowPlaying = document.getElementById('now-playing');
        this.hls = null;
        this.currentChannel = null;
        this.overlayTimer = null;
        this.overlayDuration = 5000; // 5 seconds
        this.isUsingProxy = false;
        this.currentUrl = null;
        this.rawStreamUrl = null; // original upstream URL, before any transcode/remux/proxy rewriting
        this.settingsLoaded = false;
        this.playToken = 0; // guards against overlapping play() calls (e.g. rapidly toggling
        // quality) resolving out of order and leaving state from a superseded call in place

        // Recording state
        this.activeRecordingId = null;
        this.recordingUrl = null;
        this.recordingStartedAt = null;
        this.recordingTimerInterval = null;

        // Settings - start with defaults, load from server async
        this.settings = this.getDefaultSettings();

        // Load settings from server, then init
        this.loadSettingsFromServer().then(() => {
            this.init();
        });
    }

    /**
     * Default settings
     */
    getDefaultSettings() {
        return {
            arrowKeysChangeChannel: true,
            overlayDuration: 5,
            defaultVolume: 80,
            rememberVolume: true,
            lastVolume: 80,
            autoPlayNextEpisode: false,
            forceProxy: false,
            reliableStreaming: false,
            forceTranscode: false,
            forceRemux: false,
            autoTranscode: true,
            streamFormat: 'm3u8',
            epgRefreshInterval: '24'
        };
    }

    /**
     * Load settings from server API
     */
    async loadSettingsFromServer() {
        try {
            const serverSettings = await API.settings.get();
            this.settings = { ...this.getDefaultSettings(), ...serverSettings };
            this.settingsLoaded = true;
            console.log('[Player] Settings loaded from server');
        } catch (err) {
            console.warn('[Player] Failed to load settings from server, using defaults:', err.message);
            // Fall back to localStorage for backwards compatibility
            try {
                const saved = localStorage.getItem('nodecast_tv_player_settings');
                if (saved) {
                    this.settings = { ...this.getDefaultSettings(), ...JSON.parse(saved) };
                    console.log('[Player] Settings loaded from localStorage (fallback)');
                }
            } catch (localErr) {
                console.error('[Player] Error loading localStorage settings:', localErr);
            }
        }
    }

    /**
     * Save settings to server API
     */
    async saveSettings() {
        try {
            await API.settings.update(this.settings);
            console.log('[Player] Settings saved to server');
        } catch (err) {
            console.error('[Player] Error saving settings to server:', err);
            // Also save to localStorage as backup
            try {
                localStorage.setItem('nodecast_tv_player_settings', JSON.stringify(this.settings));
            } catch (localErr) {
                console.error('[Player] Error saving to localStorage:', localErr);
            }
        }
    }

    /**
     * Legacy sync method for compatibility - calls async version
     */
    loadSettings() {
        return this.settings;
    }

    /**
     * Get HLS.js configuration with buffer settings optimized for stable playback
     */
    getHlsConfig() {
        return {
            enableWorker: true,
            // Buffer settings to prevent underruns during background tab throttling
            maxBufferLength: 30,           // Buffer up to 30 seconds of content
            maxMaxBufferLength: 60,        // Absolute max buffer 60 seconds
            maxBufferSize: 60 * 1000 * 1000, // 60MB max buffer size
            maxBufferHole: 1.0,            // Allow 1s holes in buffer (helps with discontinuities)
            // Live stream settings - stay further from live edge for stability.
            // Measured this provider's actual buffer behavior directly: it
            // saw-tooths between ~1s and ~11s (one segment's worth) every
            // reload cycle rather than building a deep cushion, and at least
            // once dipped to 0.06s with readyState briefly dropping below
            // HAVE_ENOUGH_DATA - the edge of a visible stall. Sitting further
            // behind the live edge (5 segments instead of 3) gives each
            // segment more real time to have already downloaded by the time
            // playback reaches it, which is the only real lever available
            // here - the underlying cause (this provider's own manifest
            // reload/redirect cadence) isn't something we control.
            liveSyncDurationCount: 5,      // Stay 5 segments behind live
            liveMaxLatencyDurationCount: 12, // Allow up to 12 segments behind before catching up
            liveBackBufferLength: 30,      // Keep 30s of back buffer for seeking
            // Audio discontinuity handling (fixes garbled audio during ad transitions)
            stretchShortVideoTrack: true,  // Stretch short segments to avoid gaps
            forceKeyFrameOnDiscontinuity: true, // Force keyframe sync on discontinuity
            // Audio settings - prevent glitches during stream transitions
            // Higher drift tolerance = less aggressive correction = fewer glitches
            maxAudioFramesDrift: 8,        // Allow ~185ms audio drift before correction (was 4)
            // Disable progressive/streaming mode for stability with discontinuities
            progressive: false,
            // Stall recovery settings
            nudgeOffset: 0.2,              // Larger nudge steps for recovery (default 0.1)
            nudgeMaxRetry: 6,              // More retry attempts (default 3)
            // Faster recovery from errors
            levelLoadingMaxRetry: 4,
            manifestLoadingMaxRetry: 4,
            fragLoadingMaxRetry: 6,
            // Low latency mode off for more stable audio
            lowLatencyMode: false,
            // Caption/Subtitle settings
            enableCEA708Captions: true,    // Enable CEA-708 closed captions
            enableWebVTT: true,            // Enable WebVTT subtitles
            renderTextTracksNatively: true // Use native browser rendering for text tracks
        };
    }

    /**
     * Initialize custom video controls for mobile
     */
    /**
     * Initialize custom video controls
     */
    initCustomControls() {
        // Elements
        this.controlsOverlay = document.getElementById('player-controls-overlay');
        this.loadingSpinner = document.getElementById('player-loading');

        // iOS Safari: detect and compensate for floating bottom toolbar
        const updateIosUiBottom = () => {
            let uiBottom = 0;
            if (window.visualViewport) {
                const vv = window.visualViewport;
                uiBottom = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
            }
            document.documentElement.style.setProperty('--ios-ui-bottom', uiBottom + 'px');
        };

        updateIosUiBottom();

        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', updateIosUiBottom);
            window.visualViewport.addEventListener('scroll', updateIosUiBottom);
        } else {
            window.addEventListener('resize', updateIosUiBottom);
        }

        // iOS: use custom --vh unit to avoid 100vh issues with dynamic toolbar.
        // This has to be recalculated on rotation, not just set once at load -
        // window.innerHeight swaps on orientation change, and without updating
        // both the variable and the container's height, the container keeps
        // its old (now wrong) height after rotating, effectively hiding the
        // video off-viewport.
        const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
        if (isIOS && this.container) {
            const updateIosViewportHeight = () => {
                const vh = window.innerHeight * 0.01;
                document.documentElement.style.setProperty('--vh', `${vh}px`);
                this.container.style.height = 'calc(var(--vh) * 100)';
            };

            updateIosViewportHeight();
            window.addEventListener('orientationchange', updateIosViewportHeight);
            window.addEventListener('resize', updateIosViewportHeight);
            if (window.visualViewport) {
                window.visualViewport.addEventListener('resize', updateIosViewportHeight);
            }
        }

        // Apply safe area + iOS toolbar padding to controls overlay
        if (this.controlsOverlay) {
            this.controlsOverlay.style.paddingBottom = 'calc(env(safe-area-inset-bottom, 0px) + var(--ios-ui-bottom, 0px) + 12px)';
        }

        const btnPlay = document.getElementById('btn-play');
        const btnMute = document.getElementById('btn-mute');
        const btnFullscreen = document.getElementById('btn-fullscreen');
        const volumeSlider = document.getElementById('player-volume');
        const channelNameEl = document.getElementById('player-channel-name');

        if (!this.controlsOverlay) return;

        // Disable native controls
        this.video.controls = false;

        // Initial State: Hide all overlay elements until content is loaded
        this.loadingSpinner?.classList.remove('show');
        this.controlsOverlay?.classList.add('hidden');

        // Play/Pause toggle
        const togglePlay = () => {
            if (this.video.paused) {
                this.video.play();
            } else {
                this.video.pause();
            }
        };

        btnPlay?.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePlay();
        });

        // Center play button (large button shown when paused)
        const centerPlayBtn = document.getElementById('player-center-play');
        centerPlayBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePlay();
        });

        // Click on video to toggle play/pause
        this.video?.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePlay();
        });

        // Update play/pause UI. Exposed on `this` (not just a local closure)
        // so a rejected play() call elsewhere - e.g. iOS blocking autoplay
        // after the async delay of starting a transcode session - can force a
        // refresh directly. Normally this only needs to run on the video's
        // own 'play'/'pause' events, but a rejected play() never fires either
        // one (the video was already paused and never actually transitions),
        // so without this, the one button that would let the user manually
        // resume (tap = a fresh user gesture, which autoplay policies allow)
        // never appears - the video sits there loaded but frozen with no way
        // to recover.
        this.updatePlayUI = () => {
            const isPaused = this.video.paused;
            const hasVideo = this.video.src && this.video.src !== '' && this.video.readyState > 0;

            // Bottom bar button
            const iconPlay = btnPlay?.querySelector('.icon-play');
            const iconPause = btnPlay?.querySelector('.icon-pause');

            if (iconPlay && iconPause) {
                iconPlay.classList.toggle('hidden', !isPaused);
                iconPause.classList.toggle('hidden', isPaused);
            }

            // Center play button - show only when paused AND video is loaded
            if (centerPlayBtn) {
                centerPlayBtn.classList.toggle('show', isPaused && hasVideo);
            }
        };

        this.video.addEventListener('play', this.updatePlayUI);
        this.video.addEventListener('pause', this.updatePlayUI);

        // Loading spinner
        this.video.addEventListener('waiting', () => {
            this.loadingSpinner?.classList.add('show');
        });

        this.video.addEventListener('canplay', () => {
            // Deliberately NOT hiding the loading spinner here anymore -
            // canplay only means the browser could technically start
            // playing, not that it actually is. Hiding the spinner at this
            // point left a real gap: spinner gone, but the video area still
            // black because rendering hasn't actually begun, which looks
            // exactly like the app died instead of like it's still loading.
            // 'playing' below (genuine playback start) is the correct signal
            // for that. Still refreshing play/pause UI here though - canplay
            // fires once there's decodable data regardless of whether a
            // play() call actually succeeded, so this is the one place
            // guaranteed to catch a silently-rejected autoplay (no 'play' or
            // 'pause' event fires for that, since the video never actually
            // changes state) and show the center play button so there's a
            // way to manually resume instead of a frozen, unrecoverable video.
            this.updatePlayUI?.();
        });

        this.video.addEventListener('playing', () => {
            this.loadingSpinner?.classList.remove('show');
        });

        // Mute/Volume
        const updateVolumeUI = () => {
            const isMuted = this.video.muted || this.video.volume === 0;
            const iconVol = btnMute?.querySelector('.icon-vol');
            const iconMuted = btnMute?.querySelector('.icon-muted');

            if (iconVol && iconMuted) {
                iconVol.classList.toggle('hidden', isMuted);
                iconMuted.classList.toggle('hidden', !isMuted);
            }

            if (volumeSlider) {
                volumeSlider.value = this.video.muted ? 0 : Math.round(this.video.volume * 100);
            }
        };

        btnMute?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.video.muted) {
                this.video.muted = false;
                this.video.volume = (parseInt(volumeSlider?.value || 80) / 100) || 0.8;
            } else {
                this.video.muted = true;
            }
            updateVolumeUI();
        });

        volumeSlider?.addEventListener('input', (e) => {
            e.stopPropagation();
            const val = parseInt(e.target.value);
            this.video.volume = val / 100;
            this.video.muted = val === 0;
            updateVolumeUI();
        });

        this.video.addEventListener('volumechange', updateVolumeUI);

        // Captions
        this.captionsBtn = document.getElementById('player-captions-btn');
        this.captionsMenu = document.getElementById('player-captions-menu');
        this.captionsList = document.getElementById('player-captions-list');
        this.captionsMenuOpen = false;

        this.captionsBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleCaptionsMenu();
        });

        // Close captions menu when clicking outside
        document.addEventListener('click', (e) => {
            if (this.captionsMenuOpen &&
                !this.captionsMenu.contains(e.target) &&
                !this.captionsBtn.contains(e.target)) {
                this.closeCaptionsMenu();
            }
        });

        // Fullscreen
        btnFullscreen?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleFullscreen();
        });

        // Picture-in-Picture
        const btnPip = document.getElementById('btn-pip');
        btnPip?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.togglePictureInPicture();
        });

        // Overflow Menu
        const btnOverflow = document.getElementById('btn-overflow');
        const overflowMenu = document.getElementById('player-overflow-menu');

        btnOverflow?.addEventListener('click', (e) => {
            e.stopPropagation();
            overflowMenu?.classList.toggle('hidden');
        });

        // Copy Stream URL
        const btnCopyUrl = document.getElementById('btn-copy-url');
        btnCopyUrl?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.copyStreamUrl();
            overflowMenu?.classList.add('hidden');
        });

        // AirPlay - only Safari/WebKit exposes this API, so the button stays
        // hidden everywhere else (Control Center screen mirroring still works
        // as a fallback on iOS regardless, this is just the nicer per-video
        // cast that doesn't mirror the whole phone UI).
        const btnAirplay = document.getElementById('btn-airplay');
        if (btnAirplay && typeof this.video.webkitShowPlaybackTargetPicker === 'function') {
            btnAirplay.classList.remove('hidden');
            btnAirplay.addEventListener('click', (e) => {
                e.stopPropagation();
                this.video.webkitShowPlaybackTargetPicker();
                overflowMenu?.classList.add('hidden');
            });
        }

        // Stop - releases the current channel/connection without navigating
        // away, so it doesn't get silently auto-resumed by LivePage.show()
        // when you come back to Live TV (that resume is intentional recovery
        // from a background-stop, not meant to fight an explicit Stop click).
        const btnStopChannel = document.getElementById('btn-stop-channel');
        btnStopChannel?.addEventListener('click', async (e) => {
            e.stopPropagation();
            overflowMenu?.classList.add('hidden');
            // Awaited, and currentChannel cleared only after stop() actually
            // finishes - previously this fired stop() without waiting and
            // nulled currentChannel immediately, so a quick channel pick
            // right after Stop could start playing before the old session
            // had genuinely released server-side (this.currentChannel being
            // already null also defeated play()'s own "was I already on a
            // channel" check meant to add a protective pause for exactly
            // this kind of switch).
            await this.stop();
            this.currentChannel = null;
        });

        // Lower Quality - manual retry at a capped bitrate/resolution when a
        // channel keeps stalling (see the long comment in play() for why).
        // Cycles Off -> 720p -> 480p -> Off, and stays set across channel
        // changes since a provider-side CDN issue usually isn't limited to a
        // single channel.
        const btnLowBitrate = document.getElementById('btn-low-bitrate');
        const btnLowBitrateLabel = document.getElementById('btn-low-bitrate-label');
        const qualityCycle = [null, '720p', '480p'];
        const qualityLabels = {
            null: 'Lower Quality (Reduce Buffering)',
            '720p': 'Lower Quality: 720p (Click for 480p)',
            '480p': 'Lower Quality: 480p (Click to Restore)'
        };
        btnLowBitrate?.addEventListener('click', async (e) => {
            e.stopPropagation();
            // Disabled while a switch is in flight - starting a new transcode
            // session takes several real seconds (FFmpeg startup + waiting for
            // the first segment), and clicking again before the previous
            // session has actually released its connection to the provider
            // collides with it (this provider allows only one connection at a
            // time), silently failing the second attempt into a broken
            // fallback. This isn't just a UX nicety - it's what makes the
            // cycle actually reliable instead of racing itself.
            if (btnLowBitrate.disabled) return;
            const nextIndex = (qualityCycle.indexOf(this.qualityOverride) + 1) % qualityCycle.length;
            this.qualityOverride = qualityCycle[nextIndex];
            if (btnLowBitrateLabel) {
                btnLowBitrateLabel.textContent = `${qualityLabels[this.qualityOverride]} - Switching...`;
            }
            btnLowBitrate.disabled = true;
            btnLowBitrate.classList.toggle('active', !!this.qualityOverride);
            overflowMenu?.classList.add('hidden');
            if (this.currentChannel) {
                await this.play(this.currentChannel, this.rawStreamUrl);
            }
            btnLowBitrate.disabled = false;
            if (btnLowBitrateLabel) {
                btnLowBitrateLabel.textContent = qualityLabels[this.qualityOverride];
            }
        });

        // Record
        const btnRecord = document.getElementById('btn-record');
        const recordDurationPanel = document.getElementById('record-duration-panel');
        const recordDurationInput = document.getElementById('record-duration-input');
        const btnRecordConfirm = document.getElementById('btn-record-confirm');

        btnRecord?.addEventListener('click', (e) => {
            e.stopPropagation();

            // A recording is active -> clicking the row always stops it, regardless of
            // which channel is currently on screen (only one recording is tracked client-side,
            // so there's no ambiguity about which one "Stop Recording" refers to). Previously
            // this compared against currentUrl, which changes to a local transcode/proxy URL
            // whenever transcoding is active - making this comparison silently fail and the
            // button do nothing instead of stopping.
            if (this.activeRecordingId) {
                this.stopRecording();
                overflowMenu?.classList.add('hidden');
                return;
            }

            // Otherwise reveal the inline duration field instead of starting right away
            recordDurationPanel?.classList.toggle('hidden');
            if (!recordDurationPanel?.classList.contains('hidden')) {
                recordDurationInput?.focus();
            }
        });

        btnRecordConfirm?.addEventListener('click', (e) => {
            e.stopPropagation();
            const raw = recordDurationInput?.value?.trim() || '';
            this.startRecording(raw === '' ? null : Number(raw));
            recordDurationPanel?.classList.add('hidden');
            if (recordDurationInput) recordDurationInput.value = '';
            overflowMenu?.classList.add('hidden');
        });

        recordDurationInput?.addEventListener('click', (e) => e.stopPropagation());
        recordDurationInput?.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') btnRecordConfirm?.click();
        });

        // Close overflow menu when clicking outside
        document.addEventListener('click', (e) => {
            if (overflowMenu && !overflowMenu.classList.contains('hidden') &&
                !overflowMenu.contains(e.target) && e.target !== btnOverflow) {
                overflowMenu.classList.add('hidden');
            }
        });

        this.container.addEventListener('dblclick', () => this.toggleFullscreen());

        // Overlay Auto-hide Logic
        let overlayTimeout;
        const sidebarExpandBtn = document.getElementById('sidebar-expand-btn');

        const showOverlay = () => {
            this.controlsOverlay.classList.remove('hidden');
            this.container.style.cursor = 'default';
            sidebarExpandBtn?.classList.add('visible');
            resetOverlayTimer();
        };

        const hideOverlay = () => {
            if (!this.video.paused) {
                this.controlsOverlay.classList.add('hidden');
                this.container.style.cursor = 'none';
                sidebarExpandBtn?.classList.remove('visible');
            }
        };

        const resetOverlayTimer = () => {
            clearTimeout(overlayTimeout);
            if (!this.video.paused) {
                overlayTimeout = setTimeout(hideOverlay, 3000);
            }
        };

        this.container.addEventListener('mousemove', showOverlay);
        this.container.addEventListener('click', (e) => {
            showOverlay();
            // Only toggle play if clicking directly on video or container (not controls)
            if (e.target === this.video || e.target === this.container || e.target.classList.contains('watch-overlay')) {
                togglePlay();
            }
        });
        this.container.addEventListener('touchstart', showOverlay);

        this.video.addEventListener('play', resetOverlayTimer);
        this.video.addEventListener('pause', showOverlay);

        // Update Title when channel changes
        window.addEventListener('channelChanged', (e) => {
            if (channelNameEl && e.detail) {
                channelNameEl.textContent = e.detail.name || e.detail.tvgName || 'Live TV';
            }
            showOverlay();
        });

        // Initial state
        this.updatePlayUI();
        updateVolumeUI();
    }

    /**
     * Toggle fullscreen mode (cross-browser including Safari)
     */
    toggleFullscreen() {
        const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;

        if (isFullscreen) {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        } else {
            const element = this.container;
            if (element.requestFullscreen) {
                element.requestFullscreen().catch(err => console.error('Fullscreen error:', err));
            } else if (element.webkitRequestFullscreen) {
                element.webkitRequestFullscreen();
            } else if (this.video.webkitEnterFullscreen) {
                // iOS Safari: use native video fullscreen
                this.video.webkitEnterFullscreen();
            }
        }
    }

    /**
     * Toggle Picture-in-Picture mode (cross-browser including Safari)
     */
    async togglePictureInPicture() {
        try {
            // Standard PiP API (Chrome, Edge, Firefox)
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else if (document.pictureInPictureEnabled && this.video.readyState >= 2) {
                await this.video.requestPictureInPicture();
            }
            // Safari fallback using webkitPresentationMode
            else if (typeof this.video.webkitSetPresentationMode === 'function') {
                const mode = this.video.webkitPresentationMode;
                this.video.webkitSetPresentationMode(mode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
            }
        } catch (err) {
            if (err.name !== 'NotAllowedError') {
                console.error('Picture-in-Picture error:', err);
            }
        }
    }

    /**
     * Copy current stream URL to clipboard
     */
    copyStreamUrl() {
        if (!this.currentUrl) {
            console.warn('[Player] No stream URL to copy');
            return;
        }

        let streamUrl = this.currentUrl;

        // If it's a relative URL, make it absolute
        if (streamUrl.startsWith('/')) {
            streamUrl = window.location.origin + streamUrl;
        }

        const showPromptFallback = () => {
            prompt('Copy this URL:', streamUrl);
        };

        // navigator.clipboard is only available in secure contexts (HTTPS/localhost)
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(streamUrl).then(() => {
                // Show brief feedback
                const btn = document.getElementById('btn-copy-url');
                if (btn) {
                    const originalText = btn.textContent;
                    btn.textContent = '✓ Copied!';
                    setTimeout(() => {
                        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg> Copy Stream URL`;
                    }, 1500);
                }
                console.log('[Player] Stream URL copied:', streamUrl);
            }).catch(() => {
                showPromptFallback();
            });
        } else {
            // Fallback for insecure contexts (HTTP)
            showPromptFallback();
        }
    }


    /**
     * Start recording the currently playing channel.
     * @param {number|null} durationMinutes - optional auto-stop duration; null = manual stop only
     */
    async startRecording(durationMinutes) {
        if (!this.rawStreamUrl || !this.currentChannel) {
            console.warn('[Player] No channel playing, cannot record');
            return;
        }

        if (durationMinutes !== null && (!Number.isFinite(durationMinutes) || durationMinutes <= 0)) {
            alert('Enter a positive number of minutes, or leave it blank.');
            return;
        }

        // Many IPTV lines only allow ONE connection at a time - so recording must
        // reuse whatever connection is already open for live viewing, not add a
        // second one (which the provider may kill, taking down either the live
        // view or the recording). currentUrl is whatever's actually driving
        // playback right now: if transcoding/remuxing is active, that's a local
        // relay URL, and recording from it shares that same single upstream
        // connection. Only when playback is Direct (no local relay at all) does
        // recording still need its own connection - unavoidable without forcing
        // all playback through a server relay, which direct/passthrough exists
        // specifically to avoid.
        const recordUrl = this.currentUrl.startsWith('/')
            ? window.location.origin + this.currentUrl
            : this.currentUrl;

        try {
            const result = await API.recordings.start(recordUrl, this.currentChannel.name || this.currentChannel.tvgName, durationMinutes);
            this.activeRecordingId = result.id;
            this.recordingUrl = this.rawStreamUrl;
            this.recordingStartedAt = Date.now();
            this.startRecordingBadgeTimer();

            // If a duration was set, clear the local badge once the server-side
            // auto-stop should have finished, so it doesn't keep showing "REC" forever
            if (durationMinutes) {
                const recordingIdAtStart = this.activeRecordingId;
                setTimeout(() => {
                    if (this.activeRecordingId === recordingIdAtStart) {
                        this.clearRecordingState();
                    }
                }, durationMinutes * 60 * 1000 + 2000);
            }
        } catch (err) {
            console.error('[Player] Failed to start recording:', err);
            alert('Failed to start recording: ' + err.message);
        }
    }

    /**
     * Reconcile local recording state with the server. activeRecordingId only ever
     * lives in this tab's memory - a page reload (or the app being scripted/reloaded
     * externally) wipes it even though a recording can still be running server-side.
     * Called whenever a channel starts playing so the Record button reflects reality.
     */
    async syncRecordingState() {
        try {
            const active = await API.recordings.getActive();
            // Match by channel name, not URL: the recorded URL is often a local
            // relay (transcode/remux session) reused from live playback so it
            // shares the one connection the IPTV line allows, and that relay's
            // URL is a fresh session ID every time - never comparable to a
            // stable identifier like rawStreamUrl.
            const channelName = this.currentChannel?.name || this.currentChannel?.tvgName;
            const match = active.find(r => r.channelName === channelName);
            if (match) {
                this.activeRecordingId = match.id;
                this.recordingUrl = this.rawStreamUrl;
                this.recordingStartedAt = match.startedAt;
                this.startRecordingBadgeTimer();
            } else if (this.recordingUrl === this.rawStreamUrl) {
                // We thought this channel was recording but the server disagrees
                // (e.g. it auto-stopped via duration while we were away) - clear up.
                this.clearRecordingState();
            }
        } catch (err) {
            console.warn('[Player] Failed to sync recording state:', err);
        }
    }

    /**
     * Stop the active recording for the currently playing channel
     */
    async stopRecording() {
        if (!this.activeRecordingId) return;
        try {
            await API.recordings.stop(this.activeRecordingId);
        } catch (err) {
            console.error('[Player] Failed to stop recording:', err);
            if (err.message === 'Recording not found') {
                // The server has no record of it at all - nothing to keep showing
                // as "recording" locally, whatever it was is already gone.
                this.clearRecordingState();
            } else {
                // A real failure (network/server error) - don't clear local state,
                // that would show "not recording" while FFmpeg might still be running.
                alert('Failed to stop recording: ' + err.message + '\n\nCheck the Recordings page to confirm its status.');
            }
            return;
        }
        this.clearRecordingState();
    }

    /**
     * Reset local recording UI state (does not stop the server-side recording -
     * used when navigating away from the recording's channel)
     */
    clearRecordingState() {
        this.activeRecordingId = null;
        this.recordingUrl = null;
        this.recordingStartedAt = null;
        if (this.recordingTimerInterval) {
            clearInterval(this.recordingTimerInterval);
            this.recordingTimerInterval = null;
        }
        this.updateRecordingBadge();
    }

    startRecordingBadgeTimer() {
        if (this.recordingTimerInterval) clearInterval(this.recordingTimerInterval);
        this.updateRecordingBadge();
        let tick = 0;
        this.recordingTimerInterval = setInterval(() => {
            this.updateRecordingBadge();
            // The badge's elapsed time is just local arithmetic - it has no way to
            // notice the recording died server-side (network drop, provider killed
            // the connection, duration auto-stop) unless we actually ask. Without
            // this, "REC 06:18" can keep counting up indefinitely after the real
            // recording finished minutes ago. Check every 5s, not every tick, to
            // avoid hammering the server while still catching staleness quickly.
            tick++;
            if (tick % 5 === 0) this.verifyRecordingStillActive();
        }, 1000);
    }

    /**
     * Confirm the recording this tab thinks is running is still actually
     * active server-side; if not, clear the stale local state and let the
     * user know instead of leaving a phantom "REC" badge counting forever.
     */
    async verifyRecordingStillActive() {
        if (!this.activeRecordingId) return;
        try {
            const active = await API.recordings.getActive();
            const stillActive = active.some(r => r.id === this.activeRecordingId);
            if (!stillActive) {
                console.warn('[Player] Recording ended server-side without notice - clearing stale badge');
                const wasChannel = this.recordingUrl === this.rawStreamUrl;
                this.clearRecordingState();
                if (wasChannel) {
                    alert('Recording stopped earlier than expected (check the Recordings page for details - this is often the IPTV provider limiting concurrent connections if you were also watching live).');
                }
            }
        } catch (err) {
            // Network hiccup - don't clear state on an inconclusive check, only
            // on a confirmed "server says it's not active".
            console.warn('[Player] Failed to verify recording status:', err);
        }
    }

    updateRecordingBadge() {
        const badge = document.getElementById('player-recording-badge');
        const timeEl = document.getElementById('player-recording-time');
        const label = document.getElementById('btn-record-label');
        if (!badge) return;

        // The button always controls whatever the one active recording is (see click
        // handler), regardless of which channel is on screen right now.
        if (label) label.textContent = this.activeRecordingId ? 'Stop Recording' : 'Record';

        // The elapsed-time badge, on the other hand, should only show for the channel
        // actually being recorded - showing "REC 04:12" over an unrelated channel would
        // be confusing, even though Stop Recording still correctly targets the real one.
        const isRecordingThisChannel = this.activeRecordingId && this.recordingUrl === this.rawStreamUrl;
        if (!isRecordingThisChannel) {
            badge.classList.add('hidden');
            return;
        }

        const elapsedSec = Math.floor((Date.now() - this.recordingStartedAt) / 1000);
        const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
        const secs = String(elapsedSec % 60).padStart(2, '0');
        if (timeEl) timeEl.textContent = `REC ${mins}:${secs}`;
        badge.classList.remove('hidden');
    }

    /**
     * Toggle captions menu visibility
     */
    toggleCaptionsMenu() {
        if (!this.captionsMenu) return;

        this.captionsMenuOpen = !this.captionsMenuOpen;

        if (this.captionsMenuOpen) {
            this.updateCaptionsTracks();
            this.captionsMenu.classList.remove('hidden');
        } else {
            this.captionsMenu.classList.add('hidden');
        }
    }

    /**
     * Close captions menu
     */
    closeCaptionsMenu() {
        if (!this.captionsMenu) return;
        this.captionsMenuOpen = false;
        this.captionsMenu.classList.add('hidden');
    }

    /**
     * Update available caption tracks in the menu
     */
    updateCaptionsTracks() {
        if (!this.captionsList) return;

        // Clear existing list (keep only Off option)
        this.captionsList.innerHTML = '<button class="captions-option" data-index="-1">Off</button>';

        // Add tracks
        if (this.video.textTracks && this.video.textTracks.length > 0) {
            let hasActiveTrack = false;

            for (let i = 0; i < this.video.textTracks.length; i++) {
                const track = this.video.textTracks[i];
                const btn = document.createElement('button');
                btn.className = 'captions-option';
                btn.textContent = track.label || `Track ${i + 1} (${track.language || 'unknown'})`;
                btn.dataset.index = i;

                if (track.mode === 'showing') {
                    btn.classList.add('active');
                    // Add checkmark
                    btn.innerHTML += ' <span style="float: right;">✓</span>';
                    hasActiveTrack = true;
                }

                btn.onclick = (e) => {
                    e.stopPropagation();
                    this.selectCaptionTrack(i);
                };

                this.captionsList.appendChild(btn);
            }

            // Handle "Off" button state
            const offBtn = this.captionsList.querySelector('[data-index="-1"]');
            if (offBtn) {
                if (!hasActiveTrack) {
                    offBtn.classList.add('active');
                    offBtn.innerHTML += ' <span style="float: right;">✓</span>';
                }
                offBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.selectCaptionTrack(-1);
                };
            }
        }
    }

    /**
     * Select a caption track
     */
    selectCaptionTrack(index) {
        if (!this.video.textTracks) return;

        // Turn off all tracks
        for (let i = 0; i < this.video.textTracks.length; i++) {
            this.video.textTracks[i].mode = 'hidden'; // or 'disabled'
        }

        // Turn on selected track
        if (index >= 0 && index < this.video.textTracks.length) {
            this.video.textTracks[index].mode = 'showing';
        }

        this.closeCaptionsMenu();
    }

    init() {
        // Apply default/remembered volume
        const volume = this.settings.rememberVolume ? this.settings.lastVolume : this.settings.defaultVolume;
        this.video.volume = volume / 100;

        // Save volume changes
        this.video.addEventListener('volumechange', () => {
            if (this.settings.rememberVolume) {
                this.settings.lastVolume = Math.round(this.video.volume * 100);
                this.saveSettings();
            }
        });

        // Setup custom video controls
        this.initCustomControls();

        // Detect video resolution when metadata loads (works for all streams)
        this.video.addEventListener('loadedmetadata', () => {
            if (this.video.videoHeight > 0) {
                this.currentStreamInfo = {
                    width: this.video.videoWidth,
                    height: this.video.videoHeight
                };
                this.updateQualityBadge();
            }
        });

        // Initialize HLS.js if supported
        if (Hls.isSupported()) {
            this.hls = new Hls(this.getHlsConfig());
            this.lastDiscontinuity = -1; // Track discontinuity changes

            this.hls.on(Hls.Events.ERROR, (event, data) => {
                console.error('HLS error:', data.type, data.details);
                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            // Track network retry attempts
                            this.networkRetryCount = (this.networkRetryCount || 0) + 1;
                            const now = Date.now();
                            const timeSinceLastNetworkError = now - (this.lastNetworkErrorTime || 0);
                            this.lastNetworkErrorTime = now;

                            // Reset retry count if it's been more than 30 seconds since last error
                            if (timeSinceLastNetworkError > 30000) {
                                this.networkRetryCount = 1;
                            }

                            console.log(`Network error (attempt ${this.networkRetryCount}/3):`, data.details);

                            if (this.networkRetryCount <= 3 && !this.isUsingProxy) {
                                // Retry with increasing delay (1s, 2s, 3s)
                                const retryDelay = this.networkRetryCount * 1000;
                                console.log(`[HLS] Retrying in ${retryDelay}ms...`);
                                setTimeout(() => {
                                    if (this.hls) {
                                        this.hls.startLoad();
                                    }
                                }, retryDelay);
                            } else if (!this.isUsingProxy) {
                                // After 3 retries, try proxy
                                console.log('[HLS] Max retries reached, switching to proxy...');
                                this.networkRetryCount = 0;
                                this.isUsingProxy = true;
                                const proxiedUrl = this.getProxiedUrl(this.currentUrl);
                                this.hls.loadSource(proxiedUrl);
                                this.hls.startLoad();
                            } else {
                                // Already using proxy, just retry
                                console.log('[HLS] Network error on proxy, retrying...');
                                this.hls.startLoad();
                            }
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.log('Media error, attempting recovery...');
                            this.hls.recoverMediaError();
                            break;
                        default:
                            this.stop();
                            break;
                    }
                } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                    // Non-fatal media error - try to recover with cooldown to prevent loops
                    const now = Date.now();
                    const timeSinceLastRecovery = now - (this.lastRecoveryAttempt || 0);

                    // Track consecutive media errors for escalated recovery
                    if (timeSinceLastRecovery < 5000) {
                        this.mediaErrorCount = (this.mediaErrorCount || 0) + 1;
                    } else {
                        this.mediaErrorCount = 1;
                    }

                    // Only attempt recovery if more than 2 seconds since last attempt
                    if (timeSinceLastRecovery > 2000) {
                        console.log(`Non-fatal media error (${this.mediaErrorCount}x):`, data.details, '- attempting recovery');
                        this.lastRecoveryAttempt = now;

                        // If repeated errors, try swapAudioCodec which can fix audio glitches
                        if (this.mediaErrorCount >= 3) {
                            console.log('[HLS] Multiple errors detected, trying swapAudioCodec...');
                            this.hls.swapAudioCodec();
                            this.mediaErrorCount = 0;
                        }

                        this.hls.recoverMediaError();

                        // If fragParsingError, also seek forward slightly to skip corrupted segment
                        if (data.details === 'fragParsingError' && !this.video.paused && this.video.currentTime > 0) {
                            console.log('[HLS] Seeking past corrupted segment...');
                            setTimeout(() => {
                                if (this.video && !this.video.paused) {
                                    this.video.currentTime += 1;
                                }
                            }, 200);
                        }
                    } else {
                        // Too many errors in quick succession - log but don't spam recovery
                        console.log('Non-fatal media error (cooldown):', data.details);
                    }
                } else if (data.details === 'bufferAppendError') {
                    // Buffer errors during ad transitions - try recovery
                    console.log('Buffer append error, recovering...');
                    this.hls.recoverMediaError();
                }
            });

            // Detect audio track switches (can cause audio glitches on some streams)
            this.hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (event, data) => {
                console.log('Audio track switched:', data);
            });

            // Detect buffer stalls which may indicate codec issues
            this.hls.on(Hls.Events.BUFFER_STALLED_ERROR, () => {
                console.log('Buffer stalled, attempting recovery...');
                this.hls.recoverMediaError();
            });

            // Detect discontinuity changes (ad transitions) and help decoder reset
            this.hls.on(Hls.Events.FRAG_CHANGED, (event, data) => {
                const frag = data.frag;
                // Debug: log every fragment change
                console.log(`[HLS] FRAG_CHANGED: sn=${frag?.sn}, cc=${frag?.cc}, level=${frag?.level}`);

                if (frag && frag.sn !== 'initSegment') {
                    // Check if we crossed a discontinuity boundary using CC (Continuity Counter)
                    if (frag.cc !== undefined && frag.cc !== this.lastDiscontinuity) {
                        console.log(`[HLS] Discontinuity detected: CC ${this.lastDiscontinuity} -> ${frag.cc}`);
                        this.lastDiscontinuity = frag.cc;

                        // Small nudge to help decoder sync (only if playing)
                        if (!this.video.paused && this.video.currentTime > 0) {
                            const nudgeAmount = 0.01;
                            this.video.currentTime += nudgeAmount;
                        }
                    }
                }
            });

            // Listen for subtitle track updates
            this.hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (event, data) => {
                console.log('Subtitle tracks updated:', data.subtitleTracks);
                // Wait a moment for native text tracks to populate
                setTimeout(() => this.updateCaptionsTracks(), 100);
            });

            this.hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (event, data) => {
                console.log('Subtitle track switched:', data);
            });

            this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                this.video.play().catch(e => console.log('Autoplay prevented:', e));
            });
        }

        // Keyboard controls
        document.addEventListener('keydown', (e) => this.handleKeyboard(e));

        // Click on video shows overlay
        this.video.addEventListener('click', () => this.showNowPlayingOverlay());
    }

    /**
     * Show the now playing overlay briefly
     */
    showNowPlayingOverlay() {
        if (!this.currentChannel) return;

        // Clear existing timer
        if (this.overlayTimer) {
            clearTimeout(this.overlayTimer);
        }

        // Show overlay
        this.nowPlaying.classList.remove('hidden');

        // Hide after duration
        this.overlayTimer = setTimeout(() => {
            this.nowPlaying.classList.add('hidden');
        }, this.settings.overlayDuration * 1000);
    }

    /**
     * Hide the now playing overlay
     */
    hideNowPlayingOverlay() {
        if (this.overlayTimer) {
            clearTimeout(this.overlayTimer);
        }
        this.nowPlaying.classList.add('hidden');
    }

    /**
     * Start a HLS transcode session
     */
    async startTranscodeSession(url, options = {}) {
        try {
            console.log('[Player] Starting HLS transcode session...', options);
            const res = await fetch('/api/transcode/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // This player is Live TV only (WatchPage has its own session helper for VOD),
                // so mark every session 'live' - keeps the server-side segment list bounded
                // instead of growing for as long as the channel stays open.
                body: JSON.stringify({ url, sessionType: 'live', ...options })
            });
            if (!res.ok) throw new Error('Failed to start session');
            const session = await res.json();
            // Deliberately NOT setting this.currentSessionId here. This is a
            // shared method with no idea which play() call invoked it or
            // whether that call is still the current one - a stale call
            // finishing after a newer one would overwrite currentSessionId
            // with ITS (soon to be torn down) session id, leaving the actual
            // active session untracked and never stopped. Orphaned like that,
            // it keeps running and fighting the real session for this
            // provider's one-connection-at-a-time limit, which looked like
            // playback dying and looping - exactly what rapidly cycling the
            // quality button triggered. Each call site sets currentSessionId
            // itself, after its own stillCurrent() check has passed.
            return session.playlistUrl;
        } catch (err) {
            console.error('[Player] Session start failed:', err);
            // Previously fell back to `/api/transcode?url=...` here - that
            // endpoint serves a raw MP4 stream, not an HLS playlist, and
            // every caller passes this return value straight into
            // hls.loadSource()/playHls(), which can never parse an MP4 as
            // HLS. That "fallback" was guaranteed to fail a second time,
            // cascading into exactly the repeated stop/restart pattern this
            // was supposed to recover from. Rethrowing lets callers decide
            // how to actually recover (e.g. fall back to normal playback).
            throw err;
        }
    }

    /**
     * Stop and cleanup current transcode session
     */
    async stopTranscodeSession() {
        if (this.currentSessionId) {
            console.log('[Player] Stopping transcode session:', this.currentSessionId);
            try {
                // Fire and forget cleanup
                fetch(`/api/transcode/${this.currentSessionId}`, { method: 'DELETE' });
            } catch (err) {
                console.error('Failed to stop session:', err);
            }
            this.currentSessionId = null;
        }
    }

    /**
     * Play a channel
     */
    async play(channel, streamUrl) {
        // Captured before being overwritten below - whether we were already
        // actively on a different channel, regardless of whether that
        // playback happened to be using a tracked TranscodeSession (compatible
        // channels play directly/via HLS.js with no session at all).
        const wasSwitchingChannel = !!this.currentChannel && this.currentChannel.id !== channel?.id;
        this.currentChannel = channel;
        // Captured once, checked after every await below - if a newer play()
        // call has started by the time an awaited step resolves, this call
        // is stale and must not touch shared state (video element, hls
        // instance, currentSessionId, etc). Without this, rapidly toggling
        // quality could let two overlapping play() calls interleave and
        // resolve out of order, leaving the player stuck on whichever one
        // happened to finish last - including both of them briefly attaching
        // audio to the video element, which is the most likely explanation
        // for the momentary echo effect during a quality switch.
        const myToken = ++this.playToken;
        const stillCurrent = () => myToken === this.playToken;

        try {
            // Stop any WatchPage playback (movies/series) before starting Live TV
            window.app?.pages?.watch?.stop?.();

            // Stop current playback - awaited so a prior transcode session
            // (if any) has actually released its connection to the provider
            // before we try to open a new one against the same
            // one-connection-at-a-time source (see stop()'s own comment).
            await this.stop();
            if (!stillCurrent()) return; // superseded while the old session was stopping

            // Our own process being fully dead doesn't mean the provider's
            // own side has recognized the connection as released yet -
            // confirmed directly: switching BBC2 -> BBC1 immediately after
            // our session finished tearing down still got the new channel a
            // probe timeout and a failed session start, right at that exact
            // boundary. A brief pause here gives the provider a moment to
            // actually free the slot before we ask for a new one. Skipped
            // when there was nothing to switch away from, so the very first
            // channel selection isn't needlessly slower.
            if (wasSwitchingChannel) {
                await new Promise(resolve => setTimeout(resolve, 1500));
                if (!stillCurrent()) return;
            }

            this.updateTranscodeStatus('hidden');

            // Shared navbar pill - lets the connection be released from any
            // page, not just while actually on Live TV.
            window.app?.setNowPlaying(channel.name || channel.tvgName, 'live', () => this.stop());

            // Hide "select a channel" overlay
            this.overlay.classList.add('hidden');

            // Show custom controls overlay
            this.controlsOverlay?.classList.remove('hidden');
            this.loadingSpinner?.classList.add('show');

            // Determine if HLS or direct stream
            this.currentUrl = streamUrl;
            this.rawStreamUrl = streamUrl; // stays the true source URL even as currentUrl gets rewritten below
            this.updateRecordingBadge(); // Reflect this channel's recording state immediately
            this.syncRecordingState(); // Reconcile with the server in case a page reload lost track of an in-progress recording

            // Manual quality override - user-triggered when a channel keeps
            // stalling, since this provider offers no adaptive bitrate ladder
            // of its own (confirmed by inspecting several channels' manifests
            // - every one is a single fixed-quality stream, so there's
            // nothing for the player to automatically fall back to).
            // Re-encodes server-side at a capped bitrate/resolution, trading
            // this PC's CPU for a stream that needs less bandwidth. Persists
            // across channel changes until explicitly turned off, since a
            // provider-side CDN issue causing this is rarely limited to one
            // channel.
            if (this.qualityOverride) {
                const preset = VideoPlayer.QUALITY_OVERRIDE_PRESETS[this.qualityOverride];
                console.log(`[Player] Quality override active (${this.qualityOverride}) - starting reduced-quality transcode session`);
                this.updateTranscodeStatus('transcoding', `${this.qualityOverride} Quality`);
                let playlistUrl;
                try {
                    playlistUrl = await this.startTranscodeSession(streamUrl, {
                        videoMode: 'encode',
                        sessionType: 'live',
                        ...preset
                    });
                } catch (err) {
                    // Session genuinely failed to start (not just superseded -
                    // that's handled below via stillCurrent()). Turn the
                    // override off and fall through to normal playback rather
                    // than get stuck retrying a broken state, or - as it used
                    // to before startTranscodeSession stopped returning a
                    // fake fallback URL - handing hls.js an MP4 endpoint it
                    // can never parse as HLS.
                    console.error('[Player] Quality override session failed, reverting to normal playback:', err);
                    if (stillCurrent()) {
                        this.qualityOverride = null;
                        document.getElementById('btn-low-bitrate')?.classList.remove('active');
                        const label = document.getElementById('btn-low-bitrate-label');
                        if (label) label.textContent = 'Lower Quality (Reduce Buffering)';
                    }
                    playlistUrl = null;
                }
                if (!stillCurrent()) {
                    // Superseded by a newer play() call while this session was
                    // starting - release it immediately rather than leaving it
                    // running unused. Extracted from this call's own
                    // playlistUrl (not this.currentSessionId, which may
                    // already belong to the newer, superseding call by now).
                    // Nothing to release if the session failed in the first
                    // place (playlistUrl null).
                    const staleSessionId = playlistUrl?.match(/\/transcode\/([^/]+)\//)?.[1];
                    if (staleSessionId) {
                        fetch(`/api/transcode/${staleSessionId}`, { method: 'DELETE' }).catch(() => { });
                    }
                    return;
                }
                if (playlistUrl) {
                    this.currentUrl = playlistUrl;
                    this.currentSessionId = playlistUrl.match(/\/transcode\/([^/]+)\//)?.[1] || null;
                    this.playHls(playlistUrl);
                    // Deliberately skips updateNowPlaying/showNowPlayingOverlay/
                    // fetchEpgData/channelChanged here, unlike every other
                    // branch below - those are all appropriate for an actual
                    // channel change, but this is the same channel at a
                    // different quality. Showing the "now playing" overlay
                    // again was actively counterproductive: it pops up
                    // covering the "⋮" menu right as the quality-cycle
                    // button's own label updates, making the change look like
                    // it hadn't happened.
                    return;
                }
                // playlistUrl is null - the session failed and qualityOverride
                // was already reset above. Fall through to normal playback
                // below instead of returning, so the channel still ends up
                // watchable instead of just stuck.
            }

            // CHECK: Auto Transcode (Smart) - probe first, then decide
            if (this.settings.autoTranscode) {
                console.log('[Player] Auto Transcode enabled. Probing stream...');
                try {
                    const probeRes = await fetch(`/api/probe?url=${encodeURIComponent(streamUrl)}`);
                    const info = await probeRes.json();
                    if (!stillCurrent()) return; // superseded by a newer play() call while probing
                    console.log(`[Player] Probe result: video=${info.video}, audio=${info.audio}, ${info.width}x${info.height}, compatible=${info.compatible}`);

                    // Store probe result for quality badge display
                    this.currentStreamInfo = info;
                    this.updateQualityBadge();

                    // Handle subtitles from probe result
                    // Clear existing remote tracks (from previous streams)
                    const oldTracks = this.video.querySelectorAll('track');
                    oldTracks.forEach(t => t.remove());

                    if (info.subtitles && info.subtitles.length > 0) {
                        console.log(`[Player] Found ${info.subtitles.length} subtitle tracks`);
                        info.subtitles.forEach(sub => {
                            const track = document.createElement('track');
                            track.kind = 'subtitles';
                            track.label = sub.title;
                            track.srclang = sub.language;
                            track.src = `/api/subtitle?url=${encodeURIComponent(streamUrl)}&index=${sub.index}`;
                            this.video.appendChild(track);
                        });

                        // Force update of captions menu if it's open
                        if (this.captionsMenuOpen) {
                            this.updateCaptionsTracks();
                        }
                    }

                    if (info.needsTranscode || this.settings.upscaleEnabled) {
                        // Incompatible audio (AC3/EAC3/DTS) or Upscaling enabled - use transcode session
                        console.log(`[Player] Auto: Using HLS transcode session (${this.settings.upscaleEnabled ? 'Upscaling' : 'Incompatible audio/video'})`);

                        // Heuristic: If video is h264, it's likely compatible, so only copy video (audio transcode only)
                        // BUT: If upscaling is enabled, we MUST encode.
                        const videoMode = (info.video && info.video.includes('h264') && !this.settings.upscaleEnabled) ? 'copy' : 'encode';
                        const statusText = videoMode === 'copy' ? 'Transcoding (Audio)' : (this.settings.upscaleEnabled ? 'Upscaling' : 'Transcoding (Video)');
                        const statusMode = this.settings.upscaleEnabled ? 'upscaling' : 'transcoding';

                        this.updateTranscodeStatus(statusMode, statusText);
                        let playlistUrl;
                        try {
                            playlistUrl = await this.startTranscodeSession(streamUrl, {
                                videoMode,
                                videoCodec: info.video,
                                audioCodec: info.audio,
                                audioChannels: info.audioChannels,
                                sessionType: 'live'
                            });
                        } catch (err) {
                            console.error('[Player] Transcode session failed:', err);
                            if (stillCurrent()) this.showError('Failed to start playback for this channel');
                            return;
                        }
                        if (!stillCurrent()) return;
                        this.currentUrl = playlistUrl; // Update currentUrl for HLS reload
                        this.currentSessionId = playlistUrl.match(/\/transcode\/([^/]+)\//)?.[1] || null;

                        this.playHls(playlistUrl);

                        this.updateNowPlaying(channel);
                        this.showNowPlayingOverlay();
                        this.fetchEpgData(channel);
                        window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
                        return;
                    } else if (info.needsRemux) {
                        // Raw .ts container - use remux
                        console.log('[Player] Auto: Using remux (.ts container)');
                        this.updateTranscodeStatus('remuxing', 'Remux (Auto)');
                        const remuxUrl = `/api/remux?url=${encodeURIComponent(streamUrl)}&audioCodec=${encodeURIComponent(info.audio || '')}`;
                        this.currentUrl = remuxUrl;
                        this.video.src = remuxUrl;
                        this.video.play().catch(e => {
                            if (e.name !== 'AbortError') console.log('[Player] Autoplay prevented:', e);
                        });
                        this.updateNowPlaying(channel);
                        this.showNowPlayingOverlay();
                        this.fetchEpgData(channel);
                        window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
                        return;
                    }
                    // Compatible - fall through to normal HLS.js path
                    console.log('[Player] Auto: Using HLS.js (compatible)');

                    if (this.settings.reliableStreaming) {
                        // Route through a local server-side copy-remux session instead
                        // of letting the browser read the provider directly. The server
                        // holds one steady connection and absorbs the provider's network
                        // jitter/token churn; the browser just reads local segments over
                        // the LAN, the same way on HTTP and HTTPS. videoMode: 'copy'
                        // means no re-encoding (already browser-compatible), so this is
                        // cheap on CPU - it's a remux, not a transcode.
                        console.log('[Player] Reliable Streaming enabled. Starting copy session...');
                        this.updateTranscodeStatus('transcoding', 'Buffering (Server)');
                        let playlistUrl;
                        try {
                            playlistUrl = await this.startTranscodeSession(streamUrl, {
                                videoMode: 'copy',
                                videoCodec: info.video,
                                audioCodec: info.audio,
                                audioChannels: info.audioChannels,
                                sessionType: 'live'
                            });
                        } catch (err) {
                            console.error('[Player] Reliable streaming session failed, falling back to direct playback:', err);
                            playlistUrl = null;
                        }
                        if (!stillCurrent()) {
                            const staleSessionId = playlistUrl?.match(/\/transcode\/([^/]+)\//)?.[1];
                            if (staleSessionId) fetch(`/api/transcode/${staleSessionId}`, { method: 'DELETE' }).catch(() => {});
                            return;
                        }
                        if (playlistUrl) {
                            this.currentUrl = playlistUrl;
                            this.currentSessionId = playlistUrl.match(/\/transcode\/([^/]+)\//)?.[1] || null;
                            this.playHls(playlistUrl);
                            this.updateNowPlaying(channel);
                            this.showNowPlayingOverlay();
                            this.fetchEpgData(channel);
                            window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
                            return;
                        }
                        // playlistUrl null - fall through to normal direct playback below
                    }
                } catch (err) {
                    console.warn('[Player] Probe failed, using normal playback:', err.message);
                    // Continue with normal playback on probe failure
                }
            }

            // CHECK: Force Video Transcode (Full) or Upscaling
            if (this.settings.forceVideoTranscode || this.settings.upscaleEnabled) {
                const statusText = this.settings.upscaleEnabled ? 'Upscaling' : 'Transcoding (Video)';
                const statusMode = this.settings.upscaleEnabled ? 'upscaling' : 'transcoding';
                console.log(`[Player] ${statusText} enabled. Starting session (encode)...`);
                this.updateTranscodeStatus(statusMode, statusText);
                let playlistUrl;
                try {
                    playlistUrl = await this.startTranscodeSession(streamUrl, { videoMode: 'encode' });
                } catch (err) {
                    console.error('[Player] Transcode session failed:', err);
                    if (stillCurrent()) this.showError('Failed to start playback for this channel');
                    return;
                }
                if (!stillCurrent()) return;
                this.currentUrl = playlistUrl;
                this.currentSessionId = playlistUrl.match(/\/transcode\/([^/]+)\//)?.[1] || null;

                // Load HLS
                this.updateNowPlaying(channel, 'Transcoding (Video)');
                this.playHls(playlistUrl);
                return;
            }

            // CHECK: Force Audio Transcode (Copy Video) - legacy forceTranscode setting
            if (this.settings.forceTranscode) {
                console.log('[Player] Force Audio Transcode enabled. Starting session (copy)...');
                this.updateTranscodeStatus('transcoding', 'Transcoding (Audio)');

                // Probe to get video codec for HEVC tag handling
                let videoCodec = 'unknown';
                try {
                    const probeRes = await fetch(`/api/probe?url=${encodeURIComponent(streamUrl)}`);
                    const info = await probeRes.json();
                    videoCodec = info.video;
                } catch (e) { console.warn('Probe failed for force audio, assuming h264'); }

                let playlistUrl;
                try {
                    playlistUrl = await this.startTranscodeSession(streamUrl, { videoMode: 'copy', videoCodec });
                } catch (err) {
                    console.error('[Player] Transcode session failed:', err);
                    if (stillCurrent()) this.showError('Failed to start playback for this channel');
                    return;
                }
                if (!stillCurrent()) return;
                this.currentUrl = playlistUrl;
                this.currentSessionId = playlistUrl.match(/\/transcode\/([^/]+)\//)?.[1] || null;

                console.log('[Player] Playing transcoded HLS stream:', playlistUrl);
                this.playHls(playlistUrl);

                // Update UI and dispatch events
                this.updateNowPlaying(channel);
                this.showNowPlayingOverlay();
                this.fetchEpgData(channel);
                window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
                return; // Exit early
            }

            // Detected the same reliable way as the AirPlay button: presence of
            // webkitShowPlaybackTargetPicker, not just canPlayType (see the long
            // comment on the native-HLS branch below for why canPlayType alone
            // is unreliable). Needed here, before the proxy decision, because
            // native Safari/iOS needs the proxy for a reason that has nothing to
            // do with mixed content - see below.
            // Forced false: native playback here was the one remaining
            // unreliable path (spinner not showing, buffering) while
            // WatchPage's HLS.js-only playback has been confirmed stable.
            // Always using HLS.js here too - same known-good mechanism,
            // Live TV only, WatchPage/Series untouched. Costs native AirPlay
            // video for Live TV, same trade-off already accepted for Shows.
            const isSafariNative = false;

            // Proactively use proxy for:
            // 1. User enabled "Force Proxy" in settings
            // 2. Known CORS-restricted domains (like Pluto TV)
            // 3. Mixed content: this page is HTTPS but the stream is HTTP-only
            //    (true of every channel on this provider). Left to react to it
            //    instead, every single manifest/segment fetch would try the
            //    direct HTTP URL first, get silently blocked by the browser's
            //    mixed-content policy, and only THEN retry via proxy - a
            //    wasted failed round-trip on every request in the live
            //    reload cycle, not just an occasional one. That compounds
            //    into far worse buffering over HTTPS than the same channel
            //    ever showed in HTTP testing. Deciding this upfront instead
            //    of reactively-on-error skips the doomed first attempt
            //    entirely.
            // 4. Native Safari/iOS playback, unconditionally - this provider's
            //    live playlist URL redirects to a short-lived, token-bearing CDN
            //    URL (see transcodeSession.js's identical fix for FFmpeg's own
            //    input). Our proxy re-resolves that redirect fresh on every
            //    manifest/segment request (see stream proxy's manifest rewrite
            //    and cache); native Safari's reload logic does not - it keeps
            //    polling the already-resolved CDN URL until the token expires,
            //    then 404s forever, which looks exactly like "loads the first
            //    frame, then freezes." iOS's native player also prefetches
            //    segments more aggressively in parallel than HLS.js, which trips
            //    this provider's concurrency limit (see upstreamSemaphore in
            //    proxy.js) - a second, independent way to hit the same "frozen
            //    after first frame" symptom that only the proxy's queuing fixes.
            // Note: Xtream sources are otherwise NOT auto-proxied because many providers IP-lock streams
            const proxyRequiredDomains = ['pluto.tv'];
            const isMixedContent = window.location.protocol === 'https:' && streamUrl.startsWith('http://');
            const needsProxy = this.settings.forceProxy || isMixedContent || isSafariNative ||
                proxyRequiredDomains.some(domain => streamUrl.includes(domain));

            this.isUsingProxy = needsProxy;
            const finalUrl = needsProxy ? this.getProxiedUrl(streamUrl) : streamUrl;

            // Detect if this is likely an HLS stream (has .m3u8 in URL)
            const looksLikeHls = finalUrl.includes('.m3u8') || finalUrl.includes('m3u8');

            // Check if this looks like a raw stream (no HLS manifest, no common video extensions)
            // This includes .ts files AND extension-less URLs that might be TS streams
            const isRawTs = finalUrl.includes('.ts') && !finalUrl.includes('.m3u8');
            const isExtensionless = !finalUrl.includes('.m3u8') &&
                !finalUrl.includes('.mp4') &&
                !finalUrl.includes('.mkv') &&
                !finalUrl.includes('.avi') &&
                !finalUrl.includes('.ts');

            // Force Remux: Route through FFmpeg for container conversion
            // Applies to: 1) .ts streams when detected, or 2) ALL non-HLS streams when enabled
            if (this.settings.forceRemux && (isRawTs || isExtensionless)) {
                console.log('[Player] Force Remux enabled. Routing through FFmpeg remux...');
                console.log('[Player] Stream type:', isRawTs ? 'Raw TS' : 'Extension-less (assumed TS)');
                this.updateTranscodeStatus('remuxing', 'Remux (Force)');
                const remuxUrl = this.getRemuxUrl(streamUrl);
                this.video.src = remuxUrl;
                this.video.play().catch(e => {
                    if (e.name !== 'AbortError') console.log('[Player] Autoplay prevented:', e);
                });

                // Update UI and dispatch events
                this.updateNowPlaying(channel);
                this.showNowPlayingOverlay();
                this.fetchEpgData(channel);
                window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
                return;
            }

            // If raw TS detected without Force Remux enabled, show error
            if (isRawTs && !this.settings.forceRemux) {
                console.warn('[Player] Raw MPEG-TS stream detected. Browsers cannot play .ts files directly.');
                this.showError(
                    'This stream uses raw MPEG-TS format (.ts) which browsers cannot play directly.<br><br>' +
                    '<strong>To fix this:</strong><br>' +
                    '1. Enable <strong>"Force Remux"</strong> in Settings → Streaming<br>' +
                    '2. Or configure your source to output HLS (.m3u8) format'
                );
                return;
            }

            // Priority 1: Native HLS support - gated to genuine Safari/WebKit
            // specifically (isSafariNative, computed above alongside the proxy
            // decision - detected the same reliable way as the AirPlay button
            // below: presence of webkitShowPlaybackTargetPicker), NOT just
            // video.canPlayType('application/vnd.apple.mpegurl'). canPlayType
            // is a heuristic that can return a false "maybe" on some Chromium
            // builds too - when that happened, native playback was attempted
            // on a browser with no real HLS demuxer, and any stream needing
            // the CORS-proxy fallback would just spin forever (the proxy
            // served data fine per server logs, but native HLS parsing is far
            // stricter about manifest quirks than hls.js and never rendered
            // it). Checked before HLS.js even though HLS.js/MediaSource also
            // "works" on real Safari - a MediaSource-backed <video> has no
            // independent URL for AirPlay's receiver (Apple TV) to fetch and
            // decode on its own, so AirPlay silently falls back to audio-only
            // when Safari is routed through HLS.js instead of its own native
            // engine. Native playback gives it a real src the Apple TV can
            // pull from directly. Backed by startNativeStallWatch() below in
            // case this specific stream still hits the redirect/token or
            // concurrency issue the proxy (now always used here - see above)
            // is meant to prevent.
            const startDirectHlsJs = () => {
                // Priority 2: HLS.js - either as the primary path for
                // browsers without native HLS support (Chrome, Firefox,
                // etc.), or as the automatic fallback when native playback
                // stalled above.
                this.updateTranscodeStatus('direct', 'Direct HLS');
                this.updateEngineBadge('HLS.js');
                if (this.hls) {
                    this.hls.destroy();
                    this.hls = null;
                }
                this.video.src = '';

                this.hls = new Hls(this.getHlsConfig());
                this.hls.loadSource(finalUrl);
                this.hls.attachMedia(this.video);

                this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    this.video.play().catch(e => {
                        if (e.name !== 'AbortError') console.log('Autoplay prevented:', e);
                    });
                });

                // Re-attach error handler for the new Hls instance
                this.hls.on(Hls.Events.ERROR, (event, data) => {
                    if (data.fatal) {
                        const isCorsLikely = data.type === Hls.ErrorTypes.NETWORK_ERROR ||
                            (data.type === Hls.ErrorTypes.MEDIA_ERROR && data.details === 'fragParsingError');

                        // Don't proxy if it's already a local API URL
                        const isLocalApi = this.currentUrl.startsWith('/api/');

                        if (isCorsLikely && !this.isUsingProxy && !isLocalApi) {
                            console.log('CORS/Network error detected, retrying via proxy...', data.details);
                            this.isUsingProxy = true;
                            this.hls.loadSource(this.getProxiedUrl(this.currentUrl));
                            this.hls.startLoad();
                        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                            // Fatal media error - try recovery with cooldown
                            const now = Date.now();
                            if (now - (this.lastRecoveryAttempt || 0) > 2000) {
                                console.log('Fatal media error, attempting recovery...');
                                this.lastRecoveryAttempt = now;
                                this.hls.recoverMediaError();
                            }
                        } else {
                            console.error('Fatal HLS error:', data);
                        }
                    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                        // Non-fatal media error - already handled in init(), skip duplicate handling
                    }
                });

                // Detect discontinuity changes (ad transitions) for logging only
                this.lastDiscontinuity = -1;
                this.hls.on(Hls.Events.FRAG_CHANGED, (event, data) => {
                    const frag = data.frag;
                    if (frag && frag.sn !== 'initSegment') {
                        // Log discontinuity changes for debugging
                        if (frag.cc !== undefined && frag.cc !== this.lastDiscontinuity) {
                            console.log(`[HLS] Discontinuity detected: CC ${this.lastDiscontinuity} -> ${frag.cc}`);
                            this.lastDiscontinuity = frag.cc;
                            // Note: maxAudioFramesDrift: 4 handles audio sync naturally
                            // No manual seeking needed - it can cause more issues than it solves
                        }
                    }
                });
            };

            if (looksLikeHls && isSafariNative) {
                this.updateTranscodeStatus('direct', 'Direct Native');
                this.updateEngineBadge('Native');
                this.video.src = finalUrl;
                this.video.play().catch(e => {
                    if (e.name === 'AbortError') return; // Ignore interruption by new load
                    console.log('Autoplay prevented, trying proxy if CORS error:', e);
                    if (!this.isUsingProxy) {
                        this.isUsingProxy = true;
                        this.video.src = this.getProxiedUrl(streamUrl);
                        this.video.play().catch(err => {
                            if (err.name !== 'AbortError') console.error('Proxy play failed:', err);
                        });
                    }
                });
                // No auto-fallback watch here (removed - see startNativeStallWatch's
                // own comment for why): this exact branch was confirmed working
                // reliably for Live TV before that machinery existed, and every
                // attempt to tune its thresholds broke it again.
            } else if (looksLikeHls && Hls.isSupported()) {
                startDirectHlsJs();
            } else {
                // Priority 3: Try direct playback for non-HLS streams
                this.updateTranscodeStatus('direct', 'Direct Play');
                this.video.src = finalUrl;
                this.video.play().catch(e => {
                    if (e.name !== 'AbortError') console.log('Autoplay prevented:', e);
                });
            }

            // Update now playing info
            this.updateNowPlaying(channel);

            // Show the now playing overlay
            this.showNowPlayingOverlay();

            // Fetch EPG data for this channel
            this.fetchEpgData(channel);

            // Dispatch event
            window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));

        } catch (err) {
            console.error('Error playing channel:', err);
            this.showError('Failed to play channel');
        }
    }

    /**
     * Helper to play HLS stream (reduces duplication)
     *
     * Previously this always went through HLS.js for transcode/remux session
     * output, because native Safari HLS playback of our own locally-generated
     * live playlists was once observed to load the first frame and then never
     * poll for new segments. That symptom, on investigation, matches exactly
     * what happens when the FFmpeg session feeding the playlist silently dies
     * upstream (this provider's live source redirects to a short-lived,
     * token-bearing CDN URL - see the matching comment on the session's own
     * input handling in transcodeSession.js) - the last segment plays out and
     * there's nothing new to fetch, which looks identical to a native-HLS bug
     * but isn't one. Now that FFmpeg's input is proxied to survive that,
     * native playback is worth trying again for the AirPlay it enables (a
     * real network src the AirPlay receiver can pull directly, instead of the
     * audio-only fallback MediaSource-backed video gets - see the AirPlay
     * button comment in initCustomControls). startNativeStallWatch still backs
     * this up with an automatic fallback to HLS.js if a stall happens anyway,
     * so this is strictly an improvement, not a gamble on the old bug being
     * fully gone.
     */
    playHls(url) {
        this.clearNativeStallWatch();
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }

        // Always HLS.js here - never native. This URL is always our own
        // TranscodeSession output, and native playback of that has stalled on
        // the first frame unpredictably even when the session was proven
        // healthy server-side (segments actively being produced, client never
        // even requesting them) - not something a stall-watch could safely
        // catch without also breaking working playback elsewhere, tried and
        // reverted twice today already. AirPlay is audio-only for this
        // content as a result, same limitation as before native was tried
        // here at all - the original direct-from-provider path below still
        // uses native and still gives full AirPlay for anything that doesn't
        // need transcoding.

        this.playHlsJs(url);
    }

    /**
     * On-screen debug badge showing which engine is actually driving
     * playback right now (Native vs HLS.js) - added because AirPlay video
     * only works with Native, and repeated reports of "AirPlay is audio
     * only" turned out impossible to diagnose blind (server-side logs can't
     * tell which engine the client chose, or whether/when it fell back).
     * Directly observable beats inferred from here on.
     */
    updateEngineBadge(engine) {
        const el = document.getElementById('player-engine-badge');
        if (!el) return;
        el.textContent = engine;
        el.classList.remove('hidden');
    }

    /**
     * HLS.js playback for a transcode/remux session URL - the always-works
     * fallback playHls() uses on non-Safari browsers, or automatically if
     * native playback above stalls.
     */
    playHlsJs(url) {
        this.clearNativeStallWatch();
        this.updateEngineBadge('HLS.js');
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        this.video.src = '';

        this.hls = new Hls(this.getHlsConfig());
        this.hls.loadSource(url);
        this.hls.attachMedia(this.video);

        this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
            this.video.play().catch(e => {
                if (e.name !== 'AbortError') console.log('Autoplay prevented:', e);
            });
        });

        this.hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                // Simple error handling for forced HLS/transcode modes
                console.error('Fatal HLS error in transcode mode:', data);
                this.hls.destroy();
            }
        });
    }

    /**
     * Watches native <video> HLS playback for the specific "loads the first
     * frame and never advances" stall (see playHls()'s comment for the two
     * known causes) and calls onStall() once if it's detected, so playback
     * recovers via HLS.js instead of sitting frozen indefinitely. No-ops once
     * a newer call to startNativeStallWatch/clearNativeStallWatch supersedes
     * this one (channel change, stop, or the HLS.js fallback itself starting).
     */
    startNativeStallWatch(url, onStall) {
        this.clearNativeStallWatch();
        this._nativeStallUrl = url;
        let lastTime = -1;
        let stuckStreak = 0;
        let hasStarted = false;
        let neverStartedChecks = 0;
        this._nativeStallInterval = setInterval(() => {
            if (this._nativeStallUrl !== url) {
                this.clearNativeStallWatch();
                return;
            }
            if (this.video.paused || this.video.seeking) return;

            if (!hasStarted) {
                if (this.video.currentTime > 0) {
                    hasStarted = true;
                    lastTime = this.video.currentTime;
                } else {
                    // Still on the very first frame - this is normal startup
                    // buffering, not a stall. A full software re-encode can
                    // legitimately take close to the server's own 15s
                    // session-start timeout before its first segment even
                    // exists, so "hasn't started yet" gets a longer, separate
                    // grace period before being treated as a stall itself -
                    // otherwise this fires on ordinary slow-starting sessions
                    // and silently loses native playback (and AirPlay video)
                    // for exactly the content that most needs the time.
                    neverStartedChecks++;
                    if (neverStartedChecks >= 7) { // ~21s
                        console.warn('[Player] Native HLS never started, falling back to HLS.js:', url);
                        this.clearNativeStallWatch();
                        onStall();
                    }
                }
                return;
            }

            // Reverted: a videoWidth-based check lived here briefly, meant to
            // catch audio-only playback (video decode failing while audio
            // plays fine, which the currentTime check below can't see since
            // audio keeps time advancing normally). Pulled after it broke
            // Live TV, which was working before it was added - there's
            // apparently a normal, brief window right after playback starts
            // where videoWidth is legitimately still 0 before the first
            // frame decodes, and 9s wasn't a safe threshold to distinguish
            // that from a genuine failure. Not reintroducing this without a
            // reliable way to tell the two apart.

            if (this.video.currentTime === lastTime) {
                stuckStreak++;
            } else {
                stuckStreak = 0;
                lastTime = this.video.currentTime;
            }
            // ~9s (3 checks) of zero progress while "playing" - long enough to
            // not false-positive on normal buffering, short enough that the
            // fallback still feels responsive.
            if (stuckStreak >= 3) {
                console.warn('[Player] Native HLS stalled, falling back to HLS.js:', url);
                this.clearNativeStallWatch();
                onStall();
            }
        }, 3000);
    }

    clearNativeStallWatch() {
        if (this._nativeStallInterval) {
            clearInterval(this._nativeStallInterval);
            this._nativeStallInterval = null;
        }
        this._nativeStallUrl = null;
    }

    async updateTranscodeStatus(mode, text) {
        const el = document.getElementById('player-transcode-status');
        if (!el) return;

        el.className = 'transcode-status'; // Reset classes

        if (mode === 'hidden') {
            el.classList.add('hidden');
            return;
        }

        el.textContent = text || mode;
        el.classList.add(mode);

        // Ensure it's visible
        el.classList.remove('hidden');
    }

    /**
     * Get quality label from video height
     */
    getQualityLabel(height) {
        if (height >= 2160) return '4K';
        if (height >= 1440) return '1440p';
        if (height >= 1080) return '1080p';
        if (height >= 720) return '720p';
        if (height >= 480) return '480p';
        if (height > 0) return `${height}p`;
        return null;
    }

    /**
     * Update quality badge display
     */
    updateQualityBadge() {
        const badge = document.getElementById('player-quality-badge');
        if (!badge) return;

        if (this.currentStreamInfo?.height > 0) {
            badge.textContent = this.getQualityLabel(this.currentStreamInfo.height);
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }

    /**
     * Fetch EPG data for current channel
     */
    async fetchEpgData(channel) {
        if (!channel || (!channel.tvgId && !channel.epg_id)) {
            this.updateNowPlaying(channel, null);
            return;
        }
        try {
            // First, try to use the centralized EpgGuide data (already loaded)
            if (window.app && window.app.epgGuide && window.app.epgGuide.programmes) {
                const epgGuide = window.app.epgGuide;

                // Get current program from EpgGuide
                const currentProgram = epgGuide.getCurrentProgram(channel.tvgId, channel.name);

                if (currentProgram) {
                    // Find upcoming programs from the guide's data
                    const epgChannel = epgGuide.channelMap?.get(channel.tvgId) ||
                        epgGuide.channelMap?.get(channel.name?.toLowerCase());

                    let upcoming = [];
                    if (epgChannel) {
                        const now = Date.now();
                        upcoming = epgGuide.programmes
                            .filter(p => p.channelId === epgChannel.id && new Date(p.start).getTime() > now)
                            .slice(0, 5)
                            .map(p => ({
                                title: p.title,
                                start: new Date(p.start),
                                stop: new Date(p.stop),
                                description: p.desc || ''
                            }));
                    }

                    this.updateNowPlaying(channel, {
                        current: {
                            title: currentProgram.title,
                            start: new Date(currentProgram.start),
                            stop: new Date(currentProgram.stop),
                            description: currentProgram.desc || ''
                        },
                        upcoming
                    });
                    return; // Success, exit early
                }
            }

            // Fallback: Try to get EPG from Xtream API if available
            if (channel.sourceType === 'xtream' && channel.streamId) {
                const epgData = await API.proxy.xtream.shortEpg(channel.sourceId, channel.streamId);
                if (epgData && epgData.epg_listings && epgData.epg_listings.length > 0) {
                    const listings = epgData.epg_listings;
                    const now = Math.floor(Date.now() / 1000);

                    // Find current program
                    const current = listings.find(p => {
                        const start = parseInt(p.start_timestamp);
                        const end = parseInt(p.stop_timestamp);
                        return start <= now && end > now;
                    });

                    // Get upcoming programs
                    const upcoming = listings
                        .filter(p => parseInt(p.start_timestamp) > now)
                        .slice(0, 5)
                        .map(p => ({
                            title: this.decodeBase64(p.title),
                            start: new Date(parseInt(p.start_timestamp) * 1000),
                            stop: new Date(parseInt(p.stop_timestamp) * 1000),
                            description: this.decodeBase64(p.description)
                        }));

                    if (current) {
                        this.updateNowPlaying(channel, {
                            current: {
                                title: this.decodeBase64(current.title),
                                start: new Date(parseInt(current.start_timestamp) * 1000),
                                stop: new Date(parseInt(current.stop_timestamp) * 1000),
                                description: this.decodeBase64(current.description)
                            },
                            upcoming
                        });
                    }
                }
            }
        } catch (err) {
            console.log('EPG data not available:', err.message);
        }
    }

    /**
     * Get proxied URL for a stream
     */
    getProxiedUrl(url) {
        return `/api/proxy/stream?url=${encodeURIComponent(url)}`;
    }

    /**
     * Get transcoded URL for a stream (audio transcoding for browser compatibility)
     */
    getTranscodeUrl(url) {
        return `/api/transcode?url=${encodeURIComponent(url)}`;
    }

    /**
     * Get remuxed URL for a stream (container conversion only, no re-encoding)
     * Used for raw .ts streams that browsers can't play directly
     */
    getRemuxUrl(url) {
        return `/api/remux?url=${encodeURIComponent(url)}`;
    }

    /**
     * Decode base64 EPG data
     */
    decodeBase64(str) {
        if (!str) return '';
        try {
            return decodeURIComponent(escape(atob(str)));
        } catch {
            return str;
        }
    }

    /**
     * Stop playback
     */
    async stop() {
        // Stop any running transcode session first. Awaited (not
        // fire-and-forget) so callers that themselves await stop() - notably
        // play(), when switching quality on an already-playing channel - can
        // be sure the old session's release has at least been acknowledged
        // by the server before starting a new one against the same
        // one-connection-at-a-time provider. Existing callers that don't
        // await stop() are unaffected (a promise nobody awaits just resolves
        // in the background, same as before).
        await this.stopTranscodeSession();

        // Shared navbar pill
        window.app?.clearNowPlaying();

        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        this.clearNativeStallWatch();
        this.video.pause();
        this.video.src = '';
        this.video.load();

        // Reset UI to idle state
        this.overlay.classList.remove('hidden'); // Show "Select a channel"
        this.controlsOverlay?.classList.add('hidden'); // Hide controls
        this.loadingSpinner?.classList.remove('show');
        this.nowPlaying.classList.add('hidden');

        // Hide quality badge
        this.currentStreamInfo = null;
        const badge = document.getElementById('player-quality-badge');
        if (badge) badge.classList.add('hidden');
    }

    /**
     * Update now playing display
     */
    updateNowPlaying(channel, epgData = null) {
        const channelName = this.nowPlaying.querySelector('.channel-name');
        const programTitle = this.nowPlaying.querySelector('.program-title');
        const programTime = this.nowPlaying.querySelector('.program-time');
        const upNextList = document.getElementById('up-next-list');

        channelName.textContent = channel.name || channel.tvgName || 'Unknown Channel';

        if (epgData && epgData.current) {
            programTitle.textContent = epgData.current.title;
            const start = new Date(epgData.current.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const end = new Date(epgData.current.stop).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            programTime.textContent = `${start} - ${end}`;
        } else {
            programTitle.textContent = '';
            programTime.textContent = '';
        }

        // Update up next
        upNextList.innerHTML = '';
        if (epgData && epgData.upcoming) {
            epgData.upcoming.slice(0, 3).forEach(prog => {
                const li = document.createElement('li');
                const time = new Date(prog.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                li.textContent = `${time} - ${prog.title}`;
                upNextList.appendChild(li);
            });
        }
    }

    /**
     * Show error overlay
     */
    showError(message) {
        this.overlay.classList.remove('hidden');
        this.overlay.querySelector('.overlay-content').innerHTML = `<p style="color: var(--color-error);">${message}</p>`;
    }

    /**
     * Handle keyboard shortcuts
     */
    handleKeyboard(e) {
        if (document.activeElement.tagName === 'INPUT') return;

        switch (e.key) {
            case ' ':
            case 'k':
                e.preventDefault();
                this.video.paused ? this.video.play() : this.video.pause();
                break;
            case 'f':
                e.preventDefault();
                this.toggleFullscreen();
                break;
            case 'm':
                e.preventDefault();
                this.video.muted = !this.video.muted;
                break;
            case 'ArrowUp':
                if (!this.settings.arrowKeysChangeChannel) {
                    e.preventDefault();
                    this.video.volume = Math.min(1, this.video.volume + 0.1);
                }
                // If arrowKeysChangeChannel is true, let HomePage handle it
                break;
            case 'ArrowDown':
                if (!this.settings.arrowKeysChangeChannel) {
                    e.preventDefault();
                    this.video.volume = Math.max(0, this.video.volume - 0.1);
                }
                // If arrowKeysChangeChannel is true, let HomePage handle it
                break;
            case 'ArrowLeft':
                e.preventDefault();
                // Volume down when arrow keys are for channels
                if (this.settings.arrowKeysChangeChannel) {
                    this.video.volume = Math.max(0, this.video.volume - 0.1);
                }
                break;
            case 'ArrowRight':
                e.preventDefault();
                // Volume up when arrow keys are for channels
                if (this.settings.arrowKeysChangeChannel) {
                    this.video.volume = Math.min(1, this.video.volume + 0.1);
                }
                break;
            case 'PageUp':
            case 'ChannelUp':
                e.preventDefault();
                this.channelUp();
                break;
            case 'PageDown':
            case 'ChannelDown':
                e.preventDefault();
                this.channelDown();
                break;
            case 'i':
                // Show/hide info overlay
                e.preventDefault();
                if (this.nowPlaying.classList.contains('hidden')) {
                    this.showNowPlayingOverlay();
                } else {
                    this.hideNowPlayingOverlay();
                }
                break;
        }
    }

    /**
     * Go to previous channel
     */
    channelUp() {
        if (!window.app?.channelList) return;
        const channels = window.app.channelList.getVisibleChannels();
        if (channels.length === 0) return;

        const currentIdx = this.currentChannel
            ? channels.findIndex(c => c.id === this.currentChannel.id)
            : -1;

        const prevIdx = currentIdx <= 0 ? channels.length - 1 : currentIdx - 1;
        window.app.channelList.selectChannel({ channelId: channels[prevIdx].id });
    }

    /**
     * Go to next channel
     */
    channelDown() {
        if (!window.app?.channelList) return;
        const channels = window.app.channelList.getVisibleChannels();
        if (channels.length === 0) return;

        const currentIdx = this.currentChannel
            ? channels.findIndex(c => c.id === this.currentChannel.id)
            : -1;

        const nextIdx = currentIdx >= channels.length - 1 ? 0 : currentIdx + 1;
        window.app.channelList.selectChannel({ channelId: channels[nextIdx].id });
    }

}

// Export
window.VideoPlayer = VideoPlayer;
