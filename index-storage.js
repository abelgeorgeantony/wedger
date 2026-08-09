let currentUserEmail = "guest"; // Default unauthenticated state

export const AppStorage = {
    setUser(email) {
        currentUserEmail = email || "guest";
    },
    
    _getPrefix() {
        return `hledger_vfs_${currentUserEmail}_`;
    },

    /**
     * Saves file content to Local Storage.
     * @param {string} filename 
     * @param {string} content 
     */
    saveFile(filename, content) {
        try {
            localStorage.setItem(this._getPrefix() + filename, content);
            return true;
        } catch (e) {
            console.error("Failed to save to local storage", e);
            return false;
        }
    },

    /**
     * Retrieves file content from Local Storage.
     * @param {string} filename 
     * @returns {string|null}
     */
    getFile(filename) {
        return localStorage.getItem(this._getPrefix() + filename);
    },

    /**
     * Deletes a file from Local Storage.
     * @param {string} filename 
     */
    deleteFile(filename) {
        localStorage.removeItem(this._getPrefix() + filename);
    },

    /**
     * Lists all hledger files currently in Local Storage.
     * @returns {string[]} Array of filenames
     */
    listFiles() {
        const files = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith(this._getPrefix())) {
                files.push(key.substring(this._getPrefix().length));
            }
        }
        return files.sort(); // Return alphabetically sorted
    }
};