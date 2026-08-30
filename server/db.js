const fs = require('fs/promises');
const path = require('path');
const { existsSync, mkdirSync } = require('fs');

// Ensure data directory exists (sync is fine for startup)
const dataDir = path.join(__dirname, '..', 'data');
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'db.json');

// Initialize database structure
async function loadDb() {
  try {
    // Check if file exists (using fs.access is better for async, but we can catch ENOENT)
    try {
      const fileContent = await fs.readFile(dbPath, 'utf-8');
      const data = JSON.parse(fileContent);
      return {
        sources: data.sources || [],
        hiddenItems: data.hiddenItems || [],
        favorites: data.favorites || [],
        settings: data.settings || getDefaultSettings(),
        users: data.users || [],
        recordings: data.recordings || [],
        schedules: data.schedules || [],
        nextId: data.nextId || 1
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, return default
        return {
          sources: [],
          hiddenItems: [],
          favorites: [],
          settings: getDefaultSettings(),
          users: [],
          recordings: [],
          schedules: [],
          nextId: 1
        };
      }
      throw error;
    }
  } catch (err) {
    console.error('Error loading database:', err);
    // Return safe default on error to prevent crashing, but log it
    return {
      sources: [],
      hiddenItems: [],
      favorites: [],
      settings: getDefaultSettings(),
      users: [],
      recordings: [],
      schedules: [],
      nextId: 1
    };
  }
}

// Default settings
function getDefaultSettings() {
  return {
    arrowKeysChangeChannel: true,
    overlayDuration: 5,
    defaultVolume: 80,
    rememberVolume: true,
    lastVolume: 80,
    autoPlayNextEpisode: false,
    forceProxy: false,
    forceTranscode: false, // Force Audio Transcode
    forceVideoTranscode: false, // Force Video Transcode
    forceRemux: false,
    autoTranscode: true,
    streamFormat: 'm3u8',
    epgRefreshInterval: '24',
    // User-Agent settings
    userAgentPreset: 'chrome',    // chrome | vlc | tivimate | custom
    userAgentCustom: '',          // Custom UA string when preset is 'custom'
    // Transcoding settings
    hwEncoder: 'auto',            // auto | nvenc | amf | qsv | vaapi | software
    maxResolution: '1080p',       // 4k | 1080p | 720p | 480p
    quality: 'medium',            // high | medium | low
    audioMixPreset: 'auto',       // auto | itu | night | cinematic | passthrough
    // Probe cache settings
    probeCacheTTL: 300,           // 5 minutes for URL probe cache
    seriesProbeCacheDays: 7,       // 7 days for series episode probe cache
    // Upscaling settings
    upscaleEnabled: false,
    upscaleMethod: 'hardware',    // hardware | software
    upscaleTarget: '1080p',       // 1080p | 4k | 720p
    // Recording safety limits
    minFreeDiskSpaceGB: 5,        // refuse to start / force-stop recordings below this much free space
    maxRecordingHours: 8          // hard cap on any single recording's duration, even if none was requested
  };
}

// User-Agent presets
const USER_AGENT_PRESETS = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  vlc: 'VLC/3.0.20 LibVLC/3.0.20',
  tivimate: 'TiviMate/4.7.0',
};

function getUserAgent(settings) {
  if (settings.userAgentPreset === 'custom' && settings.userAgentCustom) {
    return settings.userAgentCustom;
  }
  return USER_AGENT_PRESETS[settings.userAgentPreset] || USER_AGENT_PRESETS.chrome;
}

const tmpPath = dbPath + '.tmp';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function writeDbFile(data) {
  const jsonString = JSON.stringify(data, null, 2);
  // Atomic write: write to temp file, then rename
  // Rename is atomic on most filesystems, preventing corruption on crash
  try {
    await fs.writeFile(tmpPath, jsonString);

    // On Windows, antivirus/indexing can transiently hold a lock on a
    // just-written file, making the immediately-following rename fail with
    // EPERM/EBUSY even though nothing else in this app touched it. A short
    // retry clears this almost every time without giving up correctness -
    // the rename is still atomic, we're just waiting for the lock to clear.
    let attempt = 0;
    for (;;) {
      try {
        await fs.rename(tmpPath, dbPath);
        break;
      } catch (err) {
        attempt++;
        if ((err.code === 'EPERM' || err.code === 'EBUSY') && attempt < 5) {
          await delay(50 * attempt);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    console.error('Error writing database:', err);
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Serializes the full read-modify-write cycle for every db mutation.
 *
 * Previously, only the physical file write was queued (see the old saveDb
 * write lock) - but every CRUD function independently called loadDb() first.
 * Two overlapping requests could both read the same starting snapshot, each
 * make their own change, and whichever write landed last would silently win,
 * erasing the other's change (a classic lost-update race). This caused real
 * data loss: a recording's row disappeared entirely because its create/update
 * raced against another request's read-modify-write cycle.
 *
 * All mutations now go through this single queue so a full load->mutate->save
 * cycle always completes before the next one starts.
 */
let dbQueue = Promise.resolve();

function transaction(mutator) {
  const run = dbQueue.then(async () => {
    const data = await loadDb();
    const result = await mutator(data);
    await writeDbFile(data);
    return result;
  });
  // Keep the queue moving even if this transaction throws, without letting
  // that rejection propagate into unrelated later transactions.
  dbQueue = run.catch(() => {});
  return run;
}

// Kept for any read-only callers; no longer used internally for writes.
async function saveDb(data) {
  return writeDbFile(data);
}

// Source CRUD operations
const sources = {
  async getAll() {
    const db = await loadDb();
    return db.sources;
  },

  async getById(id) {
    const db = await loadDb();
    return db.sources.find(s => s.id === parseInt(id));
  },

  async getByType(type) {
    const db = await loadDb();
    return db.sources.filter(s => s.type === type && s.enabled);
  },

  create(source) {
    return transaction(db => {
      const newSource = {
        id: db.nextId++,
        ...source,
        enabled: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      db.sources.push(newSource);
      return newSource;
    });
  },

  update(id, updates) {
    return transaction(db => {
      const index = db.sources.findIndex(s => s.id === parseInt(id));
      if (index === -1) return null;

      db.sources[index] = {
        ...db.sources[index],
        ...updates,
        updated_at: new Date().toISOString()
      };
      return db.sources[index];
    });
  },

  delete(id) {
    return transaction(db => {
      db.sources = db.sources.filter(s => s.id !== parseInt(id));
      // Also delete related hidden items and favorites
      db.hiddenItems = db.hiddenItems.filter(h => h.source_id !== parseInt(id));
      db.favorites = db.favorites.filter(f => f.source_id !== parseInt(id));
    });
  },

  toggleEnabled(id) {
    return transaction(db => {
      const source = db.sources.find(s => s.id === parseInt(id));
      if (source) {
        source.enabled = !source.enabled;
        source.updated_at = new Date().toISOString();
      }
      return source;
    });
  }
};

// Hidden items operations
const hiddenItems = {
  async getAll(sourceId = null) {
    const db = await loadDb();
    if (sourceId) {
      return db.hiddenItems.filter(h => h.source_id === parseInt(sourceId));
    }
    return db.hiddenItems;
  },

  hide(sourceId, itemType, itemId) {
    return transaction(db => {
      const exists = db.hiddenItems.find(
        h => h.source_id === parseInt(sourceId) && h.item_type === itemType && h.item_id === itemId
      );
      if (!exists) {
        db.hiddenItems.push({
          id: db.nextId++,
          source_id: parseInt(sourceId),
          item_type: itemType,
          item_id: itemId
        });
      }
    });
  },

  show(sourceId, itemType, itemId) {
    return transaction(db => {
      db.hiddenItems = db.hiddenItems.filter(
        h => !(h.source_id === parseInt(sourceId) && h.item_type === itemType && h.item_id === itemId)
      );
    });
  },

  async isHidden(sourceId, itemType, itemId) {
    const db = await loadDb();
    return db.hiddenItems.some(
      h => h.source_id === parseInt(sourceId) && h.item_type === itemType && h.item_id === itemId
    );
  },

  bulkHide(items) {
    return transaction(db => {
      items.forEach(item => {
        const { sourceId, itemType, itemId } = item;
        const exists = db.hiddenItems.find(
          h => h.source_id === parseInt(sourceId) && h.item_type === itemType && h.item_id === itemId
        );

        if (!exists) {
          db.hiddenItems.push({
            id: db.nextId++,
            source_id: parseInt(sourceId),
            item_type: itemType,
            item_id: itemId
          });
        }
      });
      return true;
    });
  },

  bulkShow(items) {
    return transaction(db => {
      const toRemove = new Set(items.map(i => `${i.sourceId}:${i.itemType}:${i.itemId}`));
      db.hiddenItems = db.hiddenItems.filter(h =>
        !toRemove.has(`${h.source_id}:${h.item_type}:${h.item_id}`)
      );
      return true;
    });
  }
};

// Favorites operations
const favorites = {
  async getAll(sourceId = null, itemType = null) {
    const db = await loadDb();
    let results = db.favorites;
    if (sourceId) {
      results = results.filter(f => f.source_id === parseInt(sourceId));
    }
    if (itemType) {
      results = results.filter(f => f.item_type === itemType);
    }
    return results;
  },

  add(sourceId, itemId, itemType = 'channel') {
    return transaction(db => {
      const exists = db.favorites.find(
        f => f.source_id === parseInt(sourceId) && f.item_id === String(itemId) && f.item_type === itemType
      );
      if (!exists) {
        db.favorites.push({
          id: db.nextId++,
          source_id: parseInt(sourceId),
          item_id: String(itemId),
          item_type: itemType, // 'channel', 'movie', 'series'
          created_at: new Date().toISOString()
        });
      }
      return true;
    });
  },

  remove(sourceId, itemId, itemType = 'channel') {
    return transaction(db => {
      db.favorites = db.favorites.filter(
        f => !(f.source_id === parseInt(sourceId) && f.item_id === String(itemId) && f.item_type === itemType)
      );
      return true;
    });
  },

  async isFavorite(sourceId, itemId, itemType = 'channel') {
    const db = await loadDb();
    return db.favorites.some(
      f => f.source_id === parseInt(sourceId) && f.item_id === String(itemId) && f.item_type === itemType
    );
  }
};

// Settings operations
const settings = {
  async get() {
    const db = await loadDb();
    return { ...getDefaultSettings(), ...db.settings };
  },

  update(newSettings) {
    return transaction(db => {
      db.settings = { ...db.settings, ...newSettings };
      return db.settings;
    });
  },

  reset() {
    return transaction(db => {
      db.settings = getDefaultSettings();
      return db.settings;
    });
  }
};

// User operations
const users = {
  async getAll() {
    const db = await loadDb();
    return db.users || [];
  },

  async getById(id) {
    const db = await loadDb();
    return db.users?.find(u => u.id === parseInt(id));
  },

  async getByUsername(username) {
    const db = await loadDb();
    return db.users?.find(u => u.username === username);
  },

  async getByOidcId(oidcId) {
    const db = await loadDb();
    return db.users?.find(u => u.oidcId === oidcId);
  },

  async getByEmail(email) {
    const db = await loadDb();
    return db.users?.find(u => u.email === email);
  },

  create(userData) {
    return transaction(db => {
      if (!db.users) db.users = [];

      if (db.users.some(u => u.username === userData.username)) {
        throw new Error('Username already exists');
      }

      const newUser = {
        id: db.nextId++,
        username: userData.username,
        // For OIDC users, passwordHash is optional
        passwordHash: userData.passwordHash || null,
        role: userData.role || 'viewer',
        oidcId: userData.oidcId || null,
        email: userData.email || null,
        createdAt: new Date().toISOString()
      };

      db.users.push(newUser);

      // Return user without password hash
      const { passwordHash, ...userWithoutPassword } = newUser;
      return userWithoutPassword;
    });
  },

  update(id, updates) {
    return transaction(db => {
      const userIndex = db.users?.findIndex(u => u.id === parseInt(id));

      if (userIndex === -1 || userIndex === undefined) {
        throw new Error('User not found');
      }

      if (updates.username && updates.username !== db.users[userIndex].username) {
        if (db.users.some(u => u.username === updates.username)) {
          throw new Error('Username already exists');
        }
      }

      db.users[userIndex] = {
        ...db.users[userIndex],
        ...updates,
        updatedAt: new Date().toISOString()
      };

      const { passwordHash, ...userWithoutPassword } = db.users[userIndex];
      return userWithoutPassword;
    });
  },

  delete(id) {
    return transaction(db => {
      const userIndex = db.users?.findIndex(u => u.id === parseInt(id));

      if (userIndex === -1 || userIndex === undefined) {
        throw new Error('User not found');
      }

      const user = db.users[userIndex];
      if (user.role === 'admin') {
        const adminCount = db.users.filter(u => u.role === 'admin').length;
        if (adminCount <= 1) {
          throw new Error('Cannot delete the last admin user');
        }
      }

      db.users.splice(userIndex, 1);
      return true;
    });
  },

  async count() {
    const db = await loadDb();
    return db.users?.length || 0;
  }
};

// Recording operations
const recordings = {
  async getAll() {
    const db = await loadDb();
    return db.recordings || [];
  },

  async getById(id) {
    const db = await loadDb();
    return db.recordings?.find(r => r.id === parseInt(id));
  },

  create({ channelName, url, filename }) {
    return transaction(db => {
      if (!db.recordings) db.recordings = [];

      const newRecording = {
        id: db.nextId++,
        channelName,
        url,
        filename,
        status: 'recording', // recording | completed | error
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        sizeBytes: null
      };
      db.recordings.push(newRecording);
      return newRecording;
    });
  },

  update(id, updates) {
    return transaction(db => {
      const index = db.recordings?.findIndex(r => r.id === parseInt(id));
      if (index === -1 || index === undefined) return null;

      db.recordings[index] = { ...db.recordings[index], ...updates };
      return db.recordings[index];
    });
  },

  delete(id) {
    return transaction(db => {
      db.recordings = (db.recordings || []).filter(r => r.id !== parseInt(id));
    });
  }
};

// Scheduled recording operations
const schedules = {
  async getAll() {
    const db = await loadDb();
    return db.schedules || [];
  },

  async getById(id) {
    const db = await loadDb();
    return db.schedules?.find(s => s.id === parseInt(id));
  },

  create({ channelName, sourceId, streamId, url, startAt, endAt }) {
    return transaction(db => {
      if (!db.schedules) db.schedules = [];

      const newSchedule = {
        id: db.nextId++,
        channelName,
        sourceId: sourceId != null ? parseInt(sourceId) : null,
        streamId: streamId != null ? String(streamId) : null,
        url: url || null, // fallback for M3U channels with no sourceId/streamId resolution
        startAt,
        endAt,
        status: 'scheduled', // scheduled | recording | completed | error | missed | cancelled
        recordingId: null,
        createdAt: new Date().toISOString()
      };
      db.schedules.push(newSchedule);
      return newSchedule;
    });
  },

  update(id, updates) {
    return transaction(db => {
      const index = db.schedules?.findIndex(s => s.id === parseInt(id));
      if (index === -1 || index === undefined) return null;

      db.schedules[index] = { ...db.schedules[index], ...updates };
      return db.schedules[index];
    });
  },

  delete(id) {
    return transaction(db => {
      db.schedules = (db.schedules || []).filter(s => s.id !== parseInt(id));
    });
  }
};

module.exports = { loadDb, saveDb, transaction, sources, hiddenItems, favorites, settings, users, recordings, schedules, getDefaultSettings, getUserAgent, USER_AGENT_PRESETS };
