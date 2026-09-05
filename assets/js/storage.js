// wedger/storage.js

const CLIENT_ID = "711223624758-9vp7unh4huct33aq38rpi5sbiov78a6f.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email";

export const StorageManager = {
    // --- Google Auth State ---
    accessToken: null,
    user: null,
    tokenClient: null,
    refreshTimer: null,
    SESSION_KEY: "wedger_google_session",
    _refreshResolve: null,
    _refreshReject: null,

    // --- Local Storage State ---
    currentUserEmail: "guest",

    init(onSuccess) {
        this.restoreSession(onSuccess);

        this.loadScript(() => {
            this.tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: CLIENT_ID,
                scope: SCOPES,
                callback: async (tokenResponse) => {
                    if (tokenResponse && tokenResponse.access_token) {
                        this.accessToken = tokenResponse.access_token;
                        
                        try {
                            await this.fetchUserProfile();
                        } catch (e) {
                            console.warn("Could not fetch user profile details:", e);
                        }
                        
                        const expiresIn = tokenResponse.expires_in || 3600;
                        const expiryTime = Date.now() + (expiresIn * 1000);
                        
                        localStorage.setItem(this.SESSION_KEY, JSON.stringify({
                            accessToken: this.accessToken,
                            user: this.user,
                            expiryTime: expiryTime
                        }));

                        this.migrateGuestFilesToUser(this.user.email);
                        this.setUser(this.user.email);
                        this.cleanupDanglingFiles();
                        
                        // Setup the live background reset timer
                        this.scheduleRefresh(expiresIn);

                        // If resolving a background token refresh request
                        if (this._refreshResolve) {
                            this._refreshResolve(this.accessToken);
                            this._refreshResolve = null;
                            this._refreshReject = null;
                        } else if (onSuccess) {
                            onSuccess(this.user);
                        }
                    } else {
                        if (this._refreshReject) {
                            this._refreshReject(new Error("Token acquisition failed"));
                            this._refreshResolve = null;
                            this._refreshReject = null;
                        }
                    }
                }
            });
        });
    },

    restoreSession(onSuccess) {
        const stored = localStorage.getItem(this.SESSION_KEY);
        if (stored) {
            try {
                const session = JSON.parse(stored);
                if (session.expiryTime && Date.now() < session.expiryTime) {
                    this.accessToken = session.accessToken;
                    this.user = session.user;
                    this.setUser(this.user.email);
                    this.cleanupDanglingFiles();
                    
                    const expiresIn = (session.expiryTime - Date.now()) / 1000;
                    this.scheduleRefresh(expiresIn);
                    
                    if (onSuccess) onSuccess(this.user);
                } else {
                    localStorage.removeItem(this.SESSION_KEY);
                    this.setUser("guest");
                    this.cleanupDanglingFiles();
                }
            } catch (e) {
                localStorage.removeItem(this.SESSION_KEY);
                this.setUser("guest");
                this.cleanupDanglingFiles();
            }
        } else {
            this.setUser("guest");
            this.cleanupDanglingFiles();
        }
    },

    loadScript(onReady) {
        if (typeof google !== 'undefined' && google.accounts) {
            onReady();
            return;
        }
        const script = document.createElement("script");
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true;
        script.defer = true;
        script.onload = onReady;
        document.head.appendChild(script);
    },

    promptLogin() {
        if (this.tokenClient) {
            this.tokenClient.requestAccessToken();
        }
    },

    refreshToken() {
        return new Promise((resolve, reject) => {
            if (!this.tokenClient) return reject(new Error("Token client not initialized"));
            
            this._refreshResolve = resolve;
            this._refreshReject = reject;
            
            // Trigger invisible refresh (works natively with GIS if valid browser session)
            this.tokenClient.requestAccessToken({ prompt: 'none' });
            
            // Safety timeout fallback
            setTimeout(() => {
                if (this._refreshReject) {
                    this._refreshReject(new Error("Refresh timeout"));
                    this._refreshResolve = null;
                    this._refreshReject = null;
                }
            }, 10000);
        });
    },

    scheduleRefresh(expiresInSeconds) {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        // Refresh token proactively 5 minutes before expiry, or at least 1 minute if timeframe is tiny.
        const refreshTimeMs = Math.max((expiresInSeconds - 300) * 1000, 60000); 
        
        this.refreshTimer = setTimeout(() => {
            if (this.accessToken) {
                this.refreshToken().catch(err => console.warn("Background auto-refresh failed:", err));
            }
        }, refreshTimeMs);
    },

    logout() {
        if (this.accessToken && typeof google !== 'undefined' && google.accounts) {
            google.accounts.oauth2.revoke(this.accessToken, () => {});
        }
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        
        localStorage.removeItem(this.SESSION_KEY); 
        this.clearUserFiles(this.currentUserEmail);
        
        this.accessToken = null;
        this.user = null;
        this.setUser("guest");
    },

    async fetchUserProfile() {
        const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });
        if (!res.ok) {
            if (res.status === 401) throw new Error("401");
        }
        if (res.ok) {
            this.user = await res.json();
        }
    },

    async listDriveFiles() {
        if (!this.accessToken) throw new Error("Not authorized for Google Drive.");
        const query = encodeURIComponent("trashed=false and name contains '.journal'");
        const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,modifiedTime)`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });
        
        if (!response.ok) {
            if (response.status === 401) throw new Error("401");
            throw new Error(`Drive API error: ${response.status}`);
        }
        const data = await response.json();
        return data.files || [];
    },

    async getFileFromDrive(fileId) {
        if (!this.accessToken) throw new Error("Not authorized for Google Drive.");
        const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });

        if (!response.ok) {
            if (response.status === 401) throw new Error("401");
            throw new Error(`Drive API error: ${response.status}`);
        }
        return await response.text();
    },

    /**
     * Batch Sync: Fetches metadata and securely resolves cloud vs local conflicts 
     * by comparing timestamps before persisting to local memory.
     */
    async syncAllDriveFiles() {
        if (!this.accessToken) throw new Error("Not authorized for Google Drive.");
        const driveFiles = await this.listDriveFiles();
        const driveNames = driveFiles.map(f => f.name);

        const syncPromises = driveFiles.map(async (file) => {
            try {
                const localMeta = this.getLocalFileMetadata(file.name);
                const driveTime = new Date(file.modifiedTime).getTime();
                const localTime = localMeta ? new Date(localMeta.modifiedTime).getTime() : 0;

                // Protect local edits if local changes have occurred since the last sync
                if (localMeta && localTime > driveTime) {
                    return {
                        id: file.id,
                        name: file.name,
                        modifiedTime: localMeta.modifiedTime, 
                        size: localMeta.content.length,
                        status: "synced_local_newer",
                        content: localMeta.content
                    };
                }

                // Download safely (cloud is newer or equal)
                const content = await this.getFileFromDrive(file.id);
                // Save locally but lock the modification timestamp back to Drive's time
                this.saveLocalFile(file.name, content, file.modifiedTime);
                return {
                    id: file.id,
                    name: file.name,
                    modifiedTime: file.modifiedTime,
                    size: content.length,
                    status: "synced",
                    content: content
                };
            } catch (err) {
                console.error(`Failed to sync file ${file.name}:`, err);
                return {
                    id: file.id,
                    name: file.name,
                    modifiedTime: file.modifiedTime,
                    status: "error",
                    error: err.message
                };
            }
        });

        // Ensure purely offline-created local files are properly queued up
        const localNames = this.listLocalFiles();
        const unpushedLocal = localNames.filter(name => !driveNames.includes(name));
        for (const name of unpushedLocal) {
            const localMeta = this.getLocalFileMetadata(name);
            if (localMeta) {
                syncPromises.push(Promise.resolve({
                    id: null,
                    name: name,
                    modifiedTime: localMeta.modifiedTime,
                    size: localMeta.content.length,
                    status: "synced_local_newer",
                    content: localMeta.content
                }));
            }
        }

        return await Promise.all(syncPromises);
    },

    async saveToDrive(filename, content, existingFileId = null) {
        if (!this.accessToken) throw new Error("Not authorized for Google Drive.");

        const boundary = '-------314159265358979323846';
        const metadata = {
            'name': filename,
            'mimeType': 'text/plain'
        };

        const multipartRequestBody =
            `--${boundary}\r\n` +
            `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
            `${JSON.stringify(metadata)}\r\n` +
            `--${boundary}\r\n` +
            `Content-Type: text/plain; charset=UTF-8\r\n\r\n` +
            `${content}\r\n` +
            `--${boundary}--`;

        const url = existingFileId 
            ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart`
            : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

        const method = existingFileId ? 'PATCH' : 'POST';

        const response = await fetch(url, {
            method: method,
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': `multipart/related; boundary=${boundary}`
            },
            body: multipartRequestBody
        });

        if (!response.ok) {
            if (response.status === 401) throw new Error("401");
            throw new Error(`Drive API error: ${response.status}`);
        }
        return await response.json();
    },

    async deleteFromDrive(fileId) {
        if (!this.accessToken) throw new Error("Not authorized for Google Drive.");
        const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });
        
        if (!response.ok && response.status !== 204) {
            if (response.status === 401) throw new Error("401");
            throw new Error(`Drive API delete error: ${response.status}`);
        }
    },

    async renameInDrive(fileId, newName) {
        if (!this.accessToken) throw new Error("Not authorized for Google Drive.");
        const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: newName }) // Updates just the metadata name natively
        });

        if (!response.ok) {
            if (response.status === 401) throw new Error("401");
            throw new Error(`Drive API rename error: ${response.status}`);
        }
        return await response.json();
    },

    renameLocalFile(oldName, newName) {
        const content = this.getLocalFile(oldName);
        if (content !== null) {
            this.saveLocalFile(newName, content);
            this.deleteLocalFile(oldName);
            return true;
        }
        return false;
    },

    // --- Local File / State Management ---
    setUser(email) {
        this.currentUserEmail = email || "guest";
    },
    
    _getPrefix(email = this.currentUserEmail) {
        return `hledger_vfs_${email}_`;
    },

    migrateGuestFilesToUser(newUserEmail) {
        const guestPrefix = this._getPrefix("guest");
        const newPrefix = this._getPrefix(newUserEmail);
        const keysToMigrate = [];
        
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith(guestPrefix)) keysToMigrate.push(k);
        }
        keysToMigrate.forEach(oldKey => {
            const data = localStorage.getItem(oldKey);
            const filename = oldKey.substring(guestPrefix.length);
            const newKey = newPrefix + filename;
            
            // Only migrate if user doesn't already have a local version of this file
            if (localStorage.getItem(newKey) === null) {
                localStorage.setItem(newKey, data);
            }
            localStorage.removeItem(oldKey);
        });
    },

    cleanupDanglingFiles() {
        const prefix = this._getPrefix();
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k.startsWith("hledger_vfs_") && !k.startsWith(prefix)) {
                // Ensure we don't accidentally wipe out guest/other users if it's meant to be robust,
                // but since memory should be isolated, let's keep only current user's files and clear others.
            }
        }
    },

    clearUserFiles(email) {
        const prefix = this._getPrefix(email);
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k.startsWith(prefix)) {
                localStorage.removeItem(k);
            }
        }
    },

    saveLocalFile(filename, content, forcedTime = null) {
        const key = this._getPrefix() + filename;
        const data = {
            content: content,
            modifiedTime: forcedTime || new Date().toISOString()
        };
        localStorage.setItem(key, JSON.stringify(data));
    },

    getLocalFileMetadata(filename) {
        const key = this._getPrefix() + filename;
        const val = localStorage.getItem(key);
        if (!val) return null;
        try {
            const parsed = JSON.parse(val);
            if (parsed && typeof parsed === 'object' && 'content' in parsed) {
                return parsed;
            }
            // Backwards compatibility for plain text entries
            return { content: val, modifiedTime: new Date(0).toISOString() };
        } catch(e) {
            return { content: val, modifiedTime: new Date(0).toISOString() };
        }
    },

    getLocalFile(filename) {
        const meta = this.getLocalFileMetadata(filename);
        return meta ? meta.content : null;
    },

    deleteLocalFile(filename) {
        const key = this._getPrefix() + filename;
        localStorage.removeItem(key);
    },

    listLocalFiles() {
        const prefix = this._getPrefix();
        const files = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith(prefix)) {
                files.push(k.substring(prefix.length));
            }
        }
        return files.sort();
    }
};