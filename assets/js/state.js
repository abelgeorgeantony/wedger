import { StorageManager } from "./storage.js";


function normalizeFilename(raw) {
    const trimmed = (raw || "").trim();
    if (!trimmed) return "";
    return trimmed.endsWith(".journal") ? trimmed : `${trimmed}.journal`;
}

// --- State Manager --------------------------------------------------
const state = {
    hledger: {
        _session: null,
        get session() { return this._session },
        set session(value) {
            const overlay = document.getElementById("loading-overlay");
            const details = document.getElementById("loading-details");
            if (!value) {
                if (overlay && details) {
                    details.textContent = "Failed to create a new hledger session. Check your connection and reload.";
                }
                console.error("Failed to create a new hledger session");
                return;
            }

            this._session = value;
            if (overlay) overlay.style.display = "none";
        },
    },
    ui: {
        _view: null,
        get view() { return this._view; },
        set view(value) {
            if (value !== "journal" && value !== "report") {
                console.error("Invalid view: " + value);
                return;
            }
            if (this._view !== value) {
                inputView.style.display = value === "journal" ? "flex" : "none";
                outputView.style.display = value === "report" ? "flex" : "none";
                viewToggleButton.textContent = value === "journal" ? "Report" : "Journal";

                this._view = value;
            }
            else {
                console.log("View is already " + this._view);
            }
        },

        _dataRendering: null,
        get dataRendering() { return this._dataRendering; },
        set dataRendering(value) {
            if ((value !== true && value !== false) && (value !== 1 && value !== 0)) {
                console.error("Value given to set state.ui.dataRendering flag is not boolean: " + value);
                return;
            }
            renderDataToggle.checked = value;
            if (value) {
                journalPanel.style.display = "none"; guiPanel.style.display = "flex";
                output.style.display = "none"; guiOutputPanel.style.display = "flex";
            } else {
                guiPanel.style.display = "none"; journalPanel.style.display = "flex";
                guiOutputPanel.style.display = "none"; output.style.display = "";
            }
            this._dataRendering = value;
        },
        _reportButtonsEnabled: null,
        get reportButtonsEnabled() { return this._reportButtonsEnabled; },
        set reportButtonsEnabled(value) {
            if ((value !== true && value !== false) && (value !== 1 && value !== 0)) {
                console.error("Value given to set state.ui.reportButtonsEnabled flag is not boolean: " + value);
                return;
            }

            for (const btn of reportButtons) {
                if (!state.files.active) {
                    btn.disabled = true;
                }
                else {
                    btn.disabled = !value;
                }
            }

            this._reportButtonsEnabled = value;
        },

        _status: { text: "", type: "info", banner: statusBanner },
        get status() { return this._status; },
        set status(payload) {
            // Accept either a plain string (defaults to "info") or an object
            const text = typeof payload === "string" ? payload : (payload?.text || "");
            const type = typeof payload === "object" && payload?.type ? payload.type : "info";
            const banner = typeof payload === "object" && payload?.banner ? payload.banner : statusBanner;
            banner.dataset.state = type;

            const textEl = banner.querySelector('[id$="status-text"]');
            if (textEl) {
                textEl.textContent = text;
                banner.onclick = text && textEl.scrollWidth > textEl.clientWidth
                    ? () => {
                        statusModalText.textContent = text;
                        statusModal.showModal();
                    }
                    : null;
            }
            else console.error("Couldn't find the text element of status banner: " + banner);

            this._status = { text, type, banner };
        },

        _darkMode: null,
        get darkMode() { return this._darkMode; },
        set darkMode(value) {
            document.documentElement.classList.toggle("dark-mode", !!value);
            settingDarkMode.checked = !!value;
            localStorage.setItem("wedger_dark_mode", value ? "1" : "0");
            this._darkMode = !!value;
        },

        _hideBanner: null,
        get hideBanner() { return this._hideBanner; },
        set hideBanner(value) {
            statusBanner.style.display = value ? "none" : "flex";
            settingHideBanner.checked = !!value;
            localStorage.setItem("wedger_hide_banner", value ? "1" : "0");
            this._hideBanner = !!value;
        },

        _fontSize: null,
        get fontSize() { return this._fontSize; },
        set fontSize(value) {
            document.documentElement.style.setProperty('--base-font-size', `${value}px`);
            fontSizeDisplay.textContent = `${value}px`;
            settingFontSize.value = value;
            localStorage.setItem('wedger_font_size', value);
            this._fontSize = value;
        },
    },
    files: {
        list: {
            _items: [],

            // Defensive copies out — callers can never bypass validation by mutating
            // an entry or the array directly and skipping the change notification.
            get all() { return this._items.map(f => ({ ...f })); },
            get(name) {
                const entry = this._items.find(f => f.name === name);
                return entry ? { ...entry } : null;
            },

            _set(items) {
                this._items = items;
                // Signal-only event — app.js re-reads state.files.list.all / .active
                // itself rather than trusting a payload, so there's no stale-data risk.
                document.dispatchEvent(new CustomEvent("files:changed"));
            },

            // Rebuild the canonical list from local storage, optionally merging in
            // fresh Drive results. Pass nothing to just re-derive from local storage
            // while keeping whatever Drive metadata is already known.
            refresh(driveResults = null) {
                const localNames = StorageManager.listLocalFiles();
                const byName = new Map(this._items.map(f => [f.name, f]));

                if (driveResults) {
                    byName.clear();
                    driveResults.forEach(f => byName.set(f.name, {
                        name: f.name, driveId: f.id, modifiedTime: f.modifiedTime, status: f.status
                    }));
                }
                localNames.forEach(name => {
                    if (!byName.has(name)) {
                        const meta = StorageManager.getLocalFileMetadata(name);
                        byName.set(name, { name, driveId: null, modifiedTime: meta?.modifiedTime || null, status: "local" });
                    }
                });
                for (const name of byName.keys()) {
                    if (!localNames.includes(name)) byName.delete(name); // dropped elsewhere
                }

                this._set(Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name)));
                return this.all;
            },

            // Called by app.js after a successful Drive upload — the only mutation
            // that's about metadata bookkeeping rather than a user-facing CRUD action.
            markSynced(name, { driveId, modifiedTime } = {}) {
                const exists = this._items.some(f => f.name === name);
                const patched = exists
                    ? this._items.map(f => f.name === name
                        ? { ...f, driveId: driveId ?? f.driveId, modifiedTime: modifiedTime ?? f.modifiedTime, status: "synced" }
                        : f)
                    : [...this._items, { name, driveId, modifiedTime, status: "synced" }];
                this._set(patched.sort((a, b) => a.name.localeCompare(b.name)));
            },

            new(rawName) {
                if (!state.hledger.session) throw new Error("hledger session isn't ready yet.");
                const name = normalizeFilename(rawName);
                if (!name) throw new Error("Filename cannot be empty.");
                if (StorageManager.getLocalFile(name) !== null) {
                    throw new Error(`A file named "${name}" already exists.`);
                }

                StorageManager.saveLocalFile(name, "");
                state.hledger.session.fs.setFile(name, "");
                this._set([...this._items, { name, driveId: null, modifiedTime: new Date().toISOString(), status: "local" }]
                    .sort((a, b) => a.name.localeCompare(b.name)));

                state.files.active = name;
                return this.get(name);
            },

            rename(oldName, rawNewName) {
                const newName = normalizeFilename(rawNewName);
                if (!newName) throw new Error("Filename cannot be empty.");
                if (newName === oldName) return this.get(oldName); // silent no-op

                const entry = this._items.find(f => f.name === oldName);
                if (!entry) throw new Error(`"${oldName}" was not found.`);
                if (StorageManager.getLocalFile(newName) !== null) {
                    throw new Error(`A file named "${newName}" already exists.`);
                }

                const content = StorageManager.getLocalFile(oldName) || "";
                state.hledger.session.fs.setFile(newName, content);
                state.hledger.session.fs.deleteFile(oldName);
                StorageManager.renameLocalFile(oldName, newName);

                this._set(this._items
                    .map(f => f.name === oldName ? { ...f, name: newName } : f)
                    .sort((a, b) => a.name.localeCompare(b.name)));

                if (state.files.active === oldName) state.files.active = newName;
                return this.get(newName);
            },

            delete(name) {
                const entry = this._items.find(f => f.name === name);
                if (!entry) return null;

                state.hledger.session.fs.deleteFile(name);
                StorageManager.deleteLocalFile(name);
                this._set(this._items.filter(f => f.name !== name));

                if (state.files.active === name) {
                    state.files.active = this._items.length > 0 ? this._items[0].name : null;
                }
                return { ...entry };
            }
        },

        _active: null,
        get active() { return this._active; },
        set active(value) {
            fileSelector.value = value || "";

            const hasFile = !!value;
            renameFileBtn.style.display = hasFile ? "" : "none";
            deleteFileBtn.style.display = hasFile ? "" : "none";

            journalText.disabled = !hasFile;
            document.getElementById("addtxnbtn").disabled = !hasFile;
            document.getElementById("importcsvbtn").disabled = !hasFile;
            if (!hasFile) {
                journalText.value = "Please create or select a journal file to begin.";
                guiPanel.innerHTML = '<span>Please create or select a journal file to begin.</span>';
                output.value = "Waiting for a journal to load.";
                state.ui.reportButtonsEnabled = false;
            }

            this._active = value;
        },

        get activeEntry() {
            return state.files.list.get(this._active);
        }
    },

    _user: null,
    get user() { return this._user; },
    set user(value) {
        const isAuthed = !!value;

        if (isAuthed) {
            googleLoginBtn.style.display = "none";
            userProfileContainer.style.display = "flex";
            userAvatar.src = value.picture;
            userAvatar.title = value.name;
            modalUserAvatar.src = value.picture;
            modalUserDisplayName.textContent = value.name;
            modalUserDisplayEmail.textContent = value.email;
            state.ui.status = { text: `Welcome, ${value.name}! Connected to Drive.`, type: "ok" };
        } else {
            googleLoginBtn.style.display = "flex";
            userProfileContainer.style.display = "none";
            userAvatar.src = "";
            userAvatar.title = "";
            state.ui.status = { text: "Logged out successfully.", type: "info" };
        }

        this._user = value;
    },
};

// Initialising
state.ui.view = "journal";
state.ui.dataRendering = true;
state.ui.darkMode = localStorage.getItem("wedger_dark_mode") === "1";
state.ui.hideBanner = localStorage.getItem("wedger_hide_banner") === "1";
state.ui.fontSize = localStorage.getItem('wedger_font_size') || 12.5;


export { state };