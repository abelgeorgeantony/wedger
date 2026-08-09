let currentUserEmail = "guest"; 

export const AppStorage = {
    setUser(email) {
        currentUserEmail = email || "guest";
    },
    
    _getPrefix() {
        return `hledger_vfs_${currentUserEmail}_`;
    },

    saveFile(filename, content) {
        try {
            localStorage.setItem(this._getPrefix() + filename, content);
            return true;
        } catch (e) {
            console.error("Failed to save to local storage", e);
            return false;
        }
    },

    getFile(filename) {
        return localStorage.getItem(this._getPrefix() + filename);
    },

    deleteFile(filename) {
        localStorage.removeItem(this._getPrefix() + filename);
    },

    listFiles() {
        const files = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith(this._getPrefix())) {
                files.push(key.substring(this._getPrefix().length));
            }
        }
        return files.sort(); 
    }
};