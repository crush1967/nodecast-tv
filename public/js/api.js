/**
 * API Client - Frontend API wrapper for NodeCast TV
 */

const API = {
    /**
     * Make API request
     */
    async request(method, endpoint, data = null) {
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        // Add authentication token if available
        const token = localStorage.getItem('authToken');
        if (token) {
            options.headers['Authorization'] = `Bearer ${token}`;
        }

        if (data) {
            options.body = JSON.stringify(data);
        }

        // Without a timeout, a stalled connection (seen especially over
        // Tailscale/remote access) leaves the fetch promise pending forever -
        // callers just show a spinner with no way to know it's actually
        // dead. Aborting after 30s turns that into a normal error so the
        // existing error/retry UI in each caller kicks in.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        let response;
        try {
            response = await fetch(`/api${endpoint}`, { ...options, signal: controller.signal });
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error('Request timed out - the server took too long to respond');
            }
            throw err;
        } finally {
            clearTimeout(timeoutId);
        }

        let result;
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            result = await response.json();
        } else {
            const text = await response.text();
            result = { error: text || 'API request failed' };
        }

        if (!response.ok) {
            // If unauthorized, redirect to login
            if (response.status === 401) {
                localStorage.removeItem('authToken');
                window.location.href = '/login.html';
                return;
            }
            throw new Error(result.error || `Server responded with ${response.status}`);
        }

        return result;
    },

    // Sources
    sources: {
        getAll: () => API.request('GET', '/sources'),
        getByType: (type) => API.request('GET', `/sources/type/${type}`),
        getById: (id) => API.request('GET', `/sources/${id}`),
        create: (data) => API.request('POST', '/sources', data),
        update: (id, data) => API.request('PUT', `/sources/${id}`, data),
        delete: (id) => API.request('DELETE', `/sources/${id}`),
        toggle: (id) => API.request('POST', `/sources/${id}/toggle`),
        test: (id) => API.request('POST', `/sources/${id}/test`),
        sync: (id) => API.request('POST', `/sources/${id}/sync`), // Manual sync
        getStatus: () => API.request('GET', '/sources/status'), // Get all statuses
        estimate: (id) => API.request('GET', `/sources/${id}/estimate`), // Estimate M3U size
        estimateByUrl: (url, type) => API.request('POST', '/sources/estimate', { url, type }), // Estimate by URL (before creation)
    },

    // Recordings
    recordings: {
        getAll: () => API.request('GET', '/recordings'),
        getActive: () => API.request('GET', '/recordings/active'),
        start: (url, channelName, durationMinutes = null) => API.request('POST', '/recordings/start', { url, channelName, durationMinutes }),
        stop: (id) => API.request('POST', `/recordings/${id}/stop`),
        delete: (id) => API.request('DELETE', `/recordings/${id}`),
        // Plain URL (not fetch) so the browser handles the file save; token is passed
        // as a query param since a normal <a href> navigation carries no Authorization header
        getDownloadUrl: (id) => `/api/recordings/${id}/download?token=${encodeURIComponent(localStorage.getItem('authToken') || '')}`,
        getStreamUrl: (id) => `${window.location.origin}/api/recordings/${id}/stream?token=${encodeURIComponent(localStorage.getItem('authToken') || '')}`
    },

    // Scheduled Recordings
    schedules: {
        getAll: () => API.request('GET', '/schedules'),
        create: (payload) => API.request('POST', '/schedules', payload),
        delete: (id) => API.request('DELETE', `/schedules/${id}`),
        extend: (id, addMinutes) => API.request('POST', `/schedules/${id}/extend`, { addMinutes })
    },

    // Channels (hidden items)
    channels: {
        getHidden: (sourceId = null) => API.request('GET', `/channels/hidden${sourceId ? `?sourceId=${sourceId}` : ''}`),
        hide: (sourceId, itemType, itemId) => API.request('POST', '/channels/hide', { sourceId, itemType, itemId }),
        show: (sourceId, itemType, itemId) => API.request('POST', '/channels/show', { sourceId, itemType, itemId }),
        isHidden: (sourceId, itemType, itemId) => API.request('GET', `/channels/hidden/check?sourceId=${sourceId}&itemType=${itemType}&itemId=${itemId}`),
        bulkHide: (items) => API.request('POST', '/channels/hide/bulk', { items }),
        bulkShow: (items) => API.request('POST', '/channels/show/bulk', { items }),
        // Fast bulk operations - single SQL statement
        showAll: (sourceId, contentType) => API.request('POST', '/channels/show/all', { sourceId, contentType }),
        hideAll: (sourceId, contentType) => API.request('POST', '/channels/hide/all', { sourceId, contentType })
    },

    // Favorites
    favorites: {
        getAll: (sourceId = null, itemType = null) => {
            let url = '/favorites';
            const params = [];
            if (sourceId) params.push(`sourceId=${sourceId}`);
            if (itemType) params.push(`itemType=${itemType}`);
            if (params.length) url += '?' + params.join('&');
            return API.request('GET', url);
        },
        add: (sourceId, itemId, itemType = 'channel') =>
            API.request('POST', '/favorites', { sourceId, itemId, itemType }),
        remove: (sourceId, itemId, itemType = 'channel') =>
            API.request('DELETE', '/favorites', { sourceId, itemId, itemType }),
        check: (sourceId, itemId, itemType = 'channel') =>
            API.request('GET', `/favorites/check?sourceId=${sourceId}&itemId=${itemId}&itemType=${itemType}`),
        move: (favoriteId, direction) =>
            API.request('POST', `/favorites/${favoriteId}/move`, { direction })
    },

    // Watch history
    history: {
        remove: (itemId) => API.request('DELETE', `/history/${encodeURIComponent(itemId)}`)
    },

    // Proxy
    proxy: {
        // Xtream
        xtream: {
            auth: (sourceId) => API.request('GET', `/proxy/xtream/${sourceId}/auth`),
            liveCategories: (sourceId, options = {}) => {
                const params = options.includeHidden ? '?includeHidden=true' : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/live_categories${params}`);
            },
            liveStreams: (sourceId, categoryId = null, options = {}) => {
                const params = [];
                if (categoryId) params.push(`category_id=${categoryId}`);
                if (options.includeHidden) params.push('includeHidden=true');
                const query = params.length ? `?${params.join('&')}` : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/live_streams${query}`);
            },
            vodCategories: (sourceId, options = {}) => {
                const params = options.includeHidden ? '?includeHidden=true' : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/vod_categories${params}`);
            },
            vodStreams: (sourceId, categoryId = null, options = {}) => {
                const params = [];
                if (categoryId) params.push(`category_id=${categoryId}`);
                if (options.includeHidden) params.push('includeHidden=true');
                const query = params.length ? `?${params.join('&')}` : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/vod_streams${query}`);
            },
            seriesCategories: (sourceId, options = {}) => {
                const params = options.includeHidden ? '?includeHidden=true' : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/series_categories${params}`);
            },
            series: (sourceId, categoryId = null, options = {}) => {
                const params = [];
                if (categoryId) params.push(`category_id=${categoryId}`);
                if (options.includeHidden) params.push('includeHidden=true');
                const query = params.length ? `?${params.join('&')}` : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/series${query}`);
            },
            seriesInfo: (sourceId, seriesId) =>
                API.request('GET', `/proxy/xtream/${sourceId}/series_info?series_id=${seriesId}`),
            shortEpg: (sourceId, streamId) => API.request('GET', `/proxy/xtream/${sourceId}/short_epg?stream_id=${streamId}`),
            getStreamUrl: (sourceId, streamId, type = 'live', container = 'm3u8') =>
                API.request('GET', `/proxy/xtream/${sourceId}/stream/${streamId}/${type}?container=${container}`)
        },

        // EPG
        epg: {
            get: (sourceId) => API.request('GET', `/proxy/epg/${sourceId}`),
            getForChannels: (sourceId, channelIds) => API.request('POST', `/proxy/epg/${sourceId}/channels`, { channelIds })
        },

        // Cache management
        cache: {
            clear: (sourceId) => API.request('DELETE', `/proxy/cache/${sourceId}`)
        }
    },

    // Settings
    settings: {
        get: () => API.request('GET', '/settings'),
        update: (data) => API.request('PUT', '/settings', data),
        reset: () => API.request('DELETE', '/settings'),
        getDefaults: () => API.request('GET', '/settings/defaults')
    },

    // Users (admin only)
    users: {
        getAll: () => API.request('GET', '/auth/users'),
        create: (data) => API.request('POST', '/auth/users', data),
        update: (id, data) => API.request('PUT', `/auth/users/${id}`, data),
        delete: (id) => API.request('DELETE', `/auth/users/${id}`)
    }
};

// Make API available globally
window.API = API;
