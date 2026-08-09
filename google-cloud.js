const CLIENT_ID = "711223624758-9vp7unh4huct33aq38rpi5sbiov78a6f.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email";

export const GoogleCloud = {
    accessToken: null,
    user: null,
    tokenClient: null,
    SESSION_KEY: "wedger_google_session",

    init(onSuccess) {
        // 1. Attempt to restore an active session before initializing
        this.restoreSession(onSuccess);

        this.loadScript(() => {
            this.tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: CLIENT_ID,
                scope: SCOPES,
                callback: async (tokenResponse) => {
                    if (tokenResponse && tokenResponse.access_token) {
                        this.accessToken = tokenResponse.access_token;
                        await this.fetchUserProfile();
                        
                        // 2. Save session state to localStorage
                        const expiresIn = tokenResponse.expires_in || 3600; // Default to 1 hour
                        const expiryTime = Date.now() + (expiresIn * 1000);
                        
                        localStorage.setItem(this.SESSION_KEY, JSON.stringify({
                            accessToken: this.accessToken,
                            user: this.user,
                            expiryTime: expiryTime
                        }));

                        if (onSuccess) onSuccess(this.user);
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
                // 3. Verify the token hasn't expired
                if (session.expiryTime && Date.now() < session.expiryTime) {
                    this.accessToken = session.accessToken;
                    this.user = session.user;
                    if (onSuccess) onSuccess(this.user);
                } else {
                    // Clear out expired session data
                    localStorage.removeItem(this.SESSION_KEY);
                }
            } catch (e) {
                // Failsafe for malformed JSON
                localStorage.removeItem(this.SESSION_KEY);
            }
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

    logout() {
        if (this.accessToken && typeof google !== 'undefined' && google.accounts) {
            google.accounts.oauth2.revoke(this.accessToken, () => {});
        }
        this.accessToken = null;
        this.user = null;
        // 4. Wipe the persisted session when explicitly logging out
        localStorage.removeItem(this.SESSION_KEY); 
    },

    async fetchUserProfile() {
        const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });
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
        
        if (!response.ok) throw new Error(`Drive API error: ${response.status}`);
        const data = await response.json();
        return data.files || [];
    },

    async getFileFromDrive(fileId) {
        if (!this.accessToken) throw new Error("Not authorized for Google Drive.");
        const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });

        if (!response.ok) throw new Error(`Drive API error: ${response.status}`);
        return await response.text();
    },

    async saveToDrive(filename, content, existingFileId = null) {
        if (!this.accessToken) throw new Error("Not authorized for Google Drive.");

        const boundary = '-------314159265358979323846';
        const delimiter = "\r\n--" + boundary + "\r\n";
        const close_delim = "\r\n--" + boundary + "--";

        const metadata = {
            'name': filename,
            'mimeType': 'text/plain'
        };

        const multipartRequestBody =
            delimiter +
            'Content-Type: application/json\r\n\r\n' +
            JSON.stringify(metadata) +
            delimiter +
            'Content-Type: text/plain\r\n\r\n' +
            content +
            close_delim;

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

        if (!response.ok) throw new Error(`Drive API error: ${response.status}`);
        return await response.json();
    }
};