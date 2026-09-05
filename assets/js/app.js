// --- Detailed Fetch Monitor logic for tracking Resource Loading ---
const originalFetch = window.fetch;
window.fetch = async (...args) => {
    const response = await originalFetch(...args);

    // Skip tracking API calls or opaque responses to prevent CORS issues
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
    if (!response.body || response.type === 'opaque' || url.includes('googleapis.com')) {
        return response;
    }

    const contentLength = response.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;
    let loaded = 0;

    const reader = response.body.getReader();
    const stream = new ReadableStream({
        async start(controller) {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    controller.close();
                    break;
                }
                loaded += value.length;
                const details = document.getElementById('loading-details');
                if (details) {
                    const resourceName = url.split('/').pop() || 'resource data';
                    const toMB = (bytes) => (bytes / (1024 * 1024)).toFixed(3);

                    details.textContent = `Fetching ${resourceName}: ${toMB(loaded)} MB ${total ? `/ ${toMB(total)} MB` : ''}`;
                }
                controller.enqueue(value);
            }
        }
    });
    return new Response(stream, { headers: response.headers, status: response.status, statusText: response.statusText });
};

const isLocalDev = window.location.protocol === "file:" || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
const libBaseUrl = isLocalDev ? "http://localhost:5001/" : "https://cdn.jsdelivr.net/gh/abelgeorgeantony/hledger-lib-wasm@main/";

import("./init.js");
const { HledgerSession } = await import(`${libBaseUrl}js/hledger.js`);
import { StorageManager } from "./storage.js";


// --- State Manager --------------------------------------------------
const state = {
    view: "input",
    isGui: true,
    currentFilename: null,
    user: null
};

let editingTxnId = null;
let driveSyncTimer = null;
const driveSyncQueue = new Map(); // filename -> content queue for debouncing
let isDriveSyncing = false;
let driveFilesList = []; // Array of synced file objects

// --- Element Selectors ----------------------------------------------
const fileSelector = document.getElementById("file-selector");
const newFileBtn = document.getElementById("new-file-btn");
const newFileModal = document.getElementById("new-file-modal");
const newFilenameInput = document.getElementById("new-filename");
const cancelNewFileBtn = document.getElementById("cancel-new-file-btn");
const createFileBtn = document.getElementById("create-file-btn");
const renameFileBtn = document.getElementById("rename-file-btn");
const deleteFileBtn = document.getElementById("delete-file-btn");
const renameFileModal = document.getElementById("rename-file-modal");
const renameFilenameInput = document.getElementById("rename-filename");
const cancelRenameFileBtn = document.getElementById("cancel-rename-file-btn");
const submitRenameFileBtn = document.getElementById("submit-rename-file-btn");

const journalText = document.querySelector("#journal-text");
const journalPanel = document.querySelector("#journal-panel");
const guiPanel = document.querySelector("#gui-panel");
const queryInput = document.querySelector("#query-input");
const forecastToggle = document.querySelector("#forecast-toggle");
const checkStrictToggle = document.querySelector("#check-strict-toggle");
const output = document.querySelector("#output");
const guiOutputPanel = document.querySelector("#gui-output-panel");
const statusBanner = document.querySelector("#status");
const statusText = document.querySelector("#status-text");
const statusModal = document.querySelector("#status-modal");
const statusModalText = document.querySelector("#status-modal-text");
const closeStatusModalBtn = document.querySelector("#close-status-modal");
const reportGroupsContainer = document.querySelector("#report-groups");
const clearButton = document.querySelector("#clear");
const viewToggleButton = document.querySelector("#view-toggle");
const inputView = document.querySelector("#input-view");
const outputView = document.querySelector("#output-view");
const guiToggle = document.getElementById("gui-toggle");
const mobileMenuBtn = document.getElementById("mobile-menu-btn");
const mobileCloseBtn = document.getElementById("mobile-close-btn");
const mainContent = document.querySelector("main");

const googleLoginBtn = document.getElementById("google-login-btn");
const userProfileContainer = document.getElementById("user-profile-container");
const userAvatar = document.getElementById("user-avatar");
const logoutBtn = document.getElementById("logout-btn");
const userAvatarBtn = document.getElementById("user-avatar-btn");
const profileModal = document.getElementById("profile-modal");
const modalUserAvatar = document.getElementById("modal-user-avatar");
const modalUserDisplayName = document.getElementById("modal-user-display-name");
const modalUserDisplayEmail = document.getElementById("modal-user-display-email");
const closeProfileModalBtn = document.getElementById("close-profile-modal");

const txnModal = document.getElementById("txn-modal");
const modalTitle = document.getElementById("modal-title");
const modalStatusBanner = document.getElementById("modal-status");
const rawToggle = document.getElementById("raw-toggle");
const visualTxnUi = document.getElementById("visual-txn-ui");
const rawTxnContainer = document.getElementById("raw-txn-container");
const rawTxnInput = document.getElementById("raw-txn-input");
const txnDate = document.getElementById("txn-date");
const txnDesc = document.getElementById("txn-desc");
const postingsContainer = document.getElementById("postings-container");
const addPostingBtn = document.getElementById("add-posting-btn");
const cancelTxnBtn = document.getElementById("cancel-txn-btn");
const submitTxnBtn = document.getElementById("submit-txn-btn");

const csvModal = document.getElementById("csv-import-modal");
const csvImportBtn = document.getElementById("importcsvbtn");
const csvCancelBtn = document.getElementById("cancel-csv-btn");
const csvAppendBtn = document.getElementById("append-csv-btn");
const csvReplaceBtn = document.getElementById("replace-csv-btn");

const settingsBtn = document.getElementById("settings-btn");
const settingsModal = document.getElementById("settings-modal");
const closeSettingsModal = document.getElementById("close-settings-modal");
const settingDarkMode = document.getElementById("setting-dark-mode");
const settingFontSize = document.getElementById("setting-font-size");
const fontSizeDisplay = document.getElementById("font-size-display");
const settingHideBanner = document.getElementById("setting-hide-banner");


let currentStatusMessage = "";
let isOpenStatusModalAttached = false;

function setStatus(text, stateType = "info", banner = statusBanner) {
    if (!text) {
        text = "";
        banner.dataset.state = "info";
    } else {
        banner.dataset.state = stateType;
    }

    currentStatusMessage = text;
    const textEl = banner.querySelector("#status-text");
    if (textEl) textEl.textContent = text;

    if (textEl && text) {
        if (textEl.scrollWidth > textEl.clientWidth) {
            banner.addEventListener("click", openStatusModal);
            isOpenStatusModalAttached = true;
        } else if (isOpenStatusModalAttached) {
            banner.removeEventListener("click", openStatusModal);
            isOpenStatusModalAttached = false;
        }
    }
}

function openStatusModal() {
    statusModalText.textContent = currentStatusMessage;
    statusModal.showModal();
}


let activeTxnCard = null;

// Close the active transaction card controls if the user taps anywhere else
document.addEventListener("touchstart", (e) => {
    if (window.innerWidth > 780 || !activeTxnCard) return;
    if (!activeTxnCard.contains(e.target)) {
        activeTxnCard.classList.remove("show-actions");
        activeTxnCard = null;
    }
}, { passive: true });

// --- Unified File State & Sync Handlers -----------------------------

/**
 * Unified Simultaneous Committer: Updates UI, Memory FS, and LocalStorage simultaneously, 
 * then queues a graceful background sync for Google Drive.
 */
function commitFileState(filename, content, triggerDriveSync = true) {
    if (!filename) return;

    // 1. Bonded UI Textarea
    if (state.currentFilename === filename && journalText.value !== content) {
        journalText.value = content;
    }

    // 2. Synchronous Virtual FS update
    session.fs.setFile(filename, content);

    // 3. Synchronous Local Storage update - Updates modifiedTime to NOW
    StorageManager.saveLocalFile(filename, content);

    // 4. Graceful Background Cloud Sync (debounced queue)
    if (triggerDriveSync) {
        queueDriveSync(filename, content);
    }
}

function queueDriveSync(filename, content) {
    if (!StorageManager.accessToken) return;
    driveSyncQueue.set(filename, content);

    clearTimeout(driveSyncTimer);
    driveSyncTimer = setTimeout(processDriveSync, 2000);
}

async function processDriveSync() {
    if (isDriveSyncing || driveSyncQueue.size === 0) return;
    isDriveSyncing = true;

    // Extract and lock current queue
    const itemsToSync = Array.from(driveSyncQueue.entries());
    driveSyncQueue.clear();

    for (const [filename, content] of itemsToSync) {
        try {
            const driveFile = driveFilesList.find(f => f.name === filename);
            const fileId = driveFile ? driveFile.id : null;

            const res = await StorageManager.saveToDrive(filename, content, fileId);

            if (!fileId && res.id) {
                driveFilesList.push({ id: res.id, name: filename, status: 'synced', modifiedTime: new Date().toISOString() });
            } else if (driveFile) {
                // Update the modified time for existing files
                driveFile.modifiedTime = new Date().toISOString();
            }

            // Refresh the modal UI if it is currently open
            if (document.getElementById('profile-modal').hasAttribute('open')) {
                updateProfileModalUI();
            }
        } catch (e) {
            console.error("Drive sync failed for", filename, e);

            if (e.message === "401" || e.message.includes("401")) {
                try {
                    // Attempt automatic background refresh without user prompting
                    await StorageManager.refreshToken();
                    // Requeue and retry sync seamlessly
                    if (!driveSyncQueue.has(filename)) driveSyncQueue.set(filename, content);
                    isDriveSyncing = false;
                    processDriveSync();
                    return;
                } catch (refreshErr) {
                    // Only fallback to manual if silent background refresh fails
                    setStatus("Session expired. Please sign in to sync.", "error");
                    StorageManager.accessToken = null;
                    document.getElementById("google-login-btn").style.display = "flex";
                    document.getElementById("user-profile-container").style.display = "none";
                    if (!driveSyncQueue.has(filename)) driveSyncQueue.set(filename, content); // Keep it queued
                    isDriveSyncing = false;
                    return; // Break out to prevent endless loop on bad token
                }
            }

            // Requeue if failed and hasn't been overwritten since
            if (!driveSyncQueue.has(filename)) {
                driveSyncQueue.set(filename, content);
            }
        }
    }

    isDriveSyncing = false;

    // Loop queue if more items were added during upload
    if (driveSyncQueue.size > 0 && StorageManager.accessToken) {
        driveSyncTimer = setTimeout(processDriveSync, 2000);
    } else if (driveSyncQueue.size === 0) {
        setStatus("Changes synced to Drive.", "ok");
    }
}

StorageManager.init(async (user) => {
    applyAuthenticatedState(user);
    await performInitialSync();
});

googleLoginBtn.addEventListener("click", () => StorageManager.promptLogin());

function applyAuthenticatedState(user) {
    state.user = user;

    googleLoginBtn.style.display = "none";
    userProfileContainer.style.display = "flex";
    userAvatar.src = user.picture;
    userAvatar.title = user.name;

    modalUserAvatar.src = user.picture;
    modalUserDisplayName.textContent = user.name;
    modalUserDisplayEmail.textContent = user.email;

    setStatus(`Welcome, ${user.name}! Connected to Drive.`, "ok");
}

logoutBtn.addEventListener("click", () => {
    StorageManager.logout();
    state.user = null;
    driveFilesList = [];
    driveSyncQueue.clear();

    profileModal.close();
    userProfileContainer.style.display = "none";
    userAvatar.src = "";
    googleLoginBtn.style.display = "flex";

    state.currentFilename = null;
    updateFileSelector();
    journalText.value = "";
    enforceFileLockdown();

    setStatus("Logged out successfully.", "info");
});

userAvatarBtn.addEventListener("click", () => {
    updateProfileModalUI();
    profileModal.showModal();
});

closeProfileModalBtn.addEventListener("click", () => {
    profileModal.close();
});

async function performInitialSync() {
    try {
        setStatus("Syncing all Google Drive files...", "loading");

        const syncedResults = await StorageManager.syncAllDriveFiles();
        driveFilesList = syncedResults.filter(f => f.status === "synced" || f.status === "synced_local_newer");

        // Populate locally
        syncedResults.forEach(file => {
            if (file.status === "synced" && file.content !== undefined) {
                // Apply drive content safely (local wasn't modified or drive is newer)
                commitFileState(file.name, file.content, false);
            } else if (file.status === "synced_local_newer" && file.content !== undefined) {
                // Local file is newer! Keep local memory but trigger sync up to Drive
                commitFileState(file.name, file.content, true);
            }
        });

        updateFileSelector();

        if (!state.currentFilename && syncedResults.length > 0) {
            state.currentFilename = syncedResults[0].name;
            fileSelector.value = state.currentFilename;
        }

        if (state.currentFilename) {
            const content = StorageManager.getLocalFile(state.currentFilename) || "";
            commitFileState(state.currentFilename, content, false);
            enforceFileLockdown();
            await reparse();
        } else {
            enforceFileLockdown();
        }

        setStatus("All Drive files synced smoothly.", "ok");
    } catch (e) {
        console.error("Initial Sync Error:", e);
        if (e.message === "401" || e.message.includes("401")) {
            setStatus("Session expired. Working offline.", "error");
            document.getElementById("google-login-btn").style.display = "flex";
            document.getElementById("user-profile-container").style.display = "none";
        } else {
            setStatus("Drive sync failed. Working offline.", "error");
        }

        // Ensure local files are loaded anyway
        updateFileSelector();
        const localFiles = StorageManager.listLocalFiles();
        if (!state.currentFilename && localFiles.length > 0) {
            state.currentFilename = localFiles[0];
            fileSelector.value = state.currentFilename;
        }

        if (state.currentFilename) {
            const content = StorageManager.getLocalFile(state.currentFilename) || "";
            commitFileState(state.currentFilename, content, false);
            enforceFileLockdown();
            await reparse();
        } else {
            enforceFileLockdown();
        }
    }
}

function updateProfileModalUI() {
    const filesListEl = document.getElementById("synced-files-list");

    if (filesListEl) {
        if (driveFilesList.length === 0) {
            filesListEl.innerHTML = `<div style="padding: 12px; font-family: var(--mono); font-size: 11px; color: var(--ink-soft); text-align: center;">No Drive files found.</div>`;
        } else {
            filesListEl.innerHTML = driveFilesList.map(f => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--rule); font-family: var(--mono); font-size: 12px;">
              <div>
                <strong style="color: var(--ink);">${escapeHtml(f.name)}</strong>
                <div style="font-size: 10px; color: var(--ink-soft);">${f.modifiedTime ? new Date(f.modifiedTime).toLocaleString() : 'Synced'}</div>
              </div>
              <span style="font-size: 10px; padding: 2px 6px; border-radius: 4px; background: #edf7f2; color: var(--accent-ink); border: 1px solid #a8d5ba;">
                ${f.status === 'error' ? 'Error' : 'Synced'}
              </span>
            </div>
          `).join('');
        }
    }
}

// --- Adapters & UI Renderers ----------------------------------------
function escapeHtml(str) { return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function adaptGenericList(data) {
    if (typeof data === 'string') return [];
    if (data && typeof data.data === 'string') return [];
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.data)) return data.data;
    return [];
}

function adaptGenericListToTable(rawData) {
    const list = adaptGenericList(rawData);
    if (list.length === 0) return { type: "table", columns: ["Result"], rows: [["No data found or returned plain text."]] };
    if (typeof list[0] !== 'object' || list[0] === null) return { type: "table", columns: ["Item"], rows: list.map(item => [String(item)]) };
    const colSet = new Set();
    list.forEach(item => Object.keys(item).forEach(k => colSet.add(k)));
    const columns = Array.from(colSet);
    const rows = list.map(item => columns.map(col => {
        const val = item[col];
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val !== undefined && val !== null ? val : "");
    }));
    return { type: "table", columns, rows };
}

function buildTreeFromFlatList(rawData) {
    const flatList = adaptGenericList(rawData);
    const rootNodes = [];
    flatList.forEach(item => {
        const acctName = item.account || item.name || item.a || "";
        if (!acctName) return;
        const amountStr = item.amount || item.balance || item.total || item.b || "";
        const parts = String(acctName).split(":");
        let currentLevel = rootNodes;
        parts.forEach((part, index) => {
            let node = currentLevel.find(n => n.name === part);
            if (!node) {
                node = { name: part, amount: (index === parts.length - 1) ? amountStr : "", children: [] };
                currentLevel.push(node);
            } else if (index === parts.length - 1 && amountStr) {
                node.amount = amountStr;
            }
            currentLevel = node.children;
        });
    });
    function rollUpTotals(node) {
        if (!node.children || node.children.length === 0) {
            const match = (node.amount || "").match(/^([^\d-]*)([-0-9.]+)/);
            return { symbol: match ? match[1] : "", val: match ? parseFloat(match[2]) : 0 };
        }
        let totalVal = 0, symbol = "";
        node.children.forEach(child => {
            const childTotal = rollUpTotals(child);
            totalVal += childTotal.val;
            if (!symbol) symbol = childTotal.symbol;
        });
        if (totalVal !== 0) {
            const formattedVal = Number.isInteger(totalVal) ? totalVal : totalVal.toFixed(2);
            node.amount = `${symbol}${formattedVal}`;
        }
        return { symbol, val: totalVal };
    }
    rootNodes.forEach(rollUpTotals);
    return rootNodes;
}

function renderUniversalTable(tableData) {
    const container = document.createElement("div"); container.className = "table-container";
    const table = document.createElement("table"); table.className = "table-ui";
    const thead = document.createElement("thead");
    thead.innerHTML = `<tr>${tableData.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    tbody.innerHTML = tableData.rows.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('');
    table.appendChild(tbody);
    container.appendChild(table);
    return container;
}

function renderTree(nodeList) {
    const container = document.createElement("div"); container.className = "tree-container";
    if (nodeList.length === 0) {
        container.innerHTML = `<div style="padding: 12px; color: var(--ink-soft); font-family: var(--mono); font-size: calc(var(--base-font-size) * 0.96);">No hierarchical data found. Switch to raw view if this is unexpected.</div>`;
        return container;
    }
    nodeList.forEach(node => container.appendChild(renderTreeNode(node)));
    return container;
}

function renderTreeNode(node) {
    if (node.children && node.children.length > 0) {
        const details = document.createElement("details"); details.className = "tree-branch"; details.open = true;
        const summary = document.createElement("summary"); summary.className = "tree-row";
        summary.innerHTML = `<span class="tree-name">${escapeHtml(node.name)}</span><span class="tree-amount">${escapeHtml(node.amount)}</span>`;
        const childrenGroup = document.createElement("div"); childrenGroup.className = "tree-children";
        node.children.forEach(child => childrenGroup.appendChild(renderTreeNode(child)));
        details.appendChild(summary); details.appendChild(childrenGroup);
        return details;
    }
    const leafRow = document.createElement("div"); leafRow.className = "tree-row tree-leaf";
    leafRow.innerHTML = `<span class="tree-name">${escapeHtml(node.name)}</span><span class="tree-amount">${escapeHtml(node.amount)}</span>`;
    return leafRow;
}

function renderText(data) {
    const pre = document.createElement("pre");
    pre.style.cssText = "font-family: var(--mono); font-size: calc(var(--base-font-size) * 0.96); padding: 12px; background: var(--panel); border: 1px solid var(--rule); border-radius: 6px; overflow-x: auto; margin: 0;";
    let text = "";
    if (typeof data === 'string') text = data;
    else if (data && typeof data.data === 'string') text = data.data;
    else text = JSON.stringify(data, null, 2);
    pre.textContent = text;
    return pre;
}

function smartRender(data) {
    const list = adaptGenericList(data);
    if (list.length === 0) return renderText(data);
    const first = list[0];
    if (typeof first === 'object' && first !== null && (first.account !== undefined || first.name !== undefined || first.a !== undefined)) {
        const hasHierarchy = list.some(item => String(item.account || item.name || item.a || "").includes(":"));
        if (hasHierarchy) return renderTree(buildTreeFromFlatList(data));
    }
    return renderUniversalTable(adaptGenericListToTable(data));
}

function adaptBalanceReport(rawData) {
    const payload = rawData.data || rawData;
    if (!payload || !Array.isArray(payload) || !Array.isArray(payload[0])) return [];
    const rows = payload[0];
    return rows.map(row => {
        const fullName = row[0];
        const amounts = row[3] || [];
        const formattedAmount = amounts.map(amt => `${amt.acommodity || ""}${amt.aquantity?.floatingPoint || 0}`).join(", ");
        return { account: fullName, amount: formattedAmount };
    });
}

function formatHledgerAmount(amountArray) {
    if (!amountArray || !Array.isArray(amountArray)) return "";
    return amountArray.map(amt => `${amt.acommodity || ""}${amt.aquantity?.floatingPoint || 0}`).join(", ");
}

function adaptRegisterReport(rawData) {
    const payload = rawData.data || rawData;
    if (!payload || !Array.isArray(payload)) return [];
    let lastDate = "", lastDesc = "";
    return payload.map(row => {
        if (row[0] !== null) lastDate = row[0];
        if (row[2] !== null) lastDesc = row[2];
        const posting = row[3] || {};
        return {
            "Date": lastDate, "Description": lastDesc, "Account": posting.paccount || "",
            "Amount": formatHledgerAmount(posting.pamount), "Balance": formatHledgerAmount(row[4])
        };
    });
}

function adaptBalanceSheetReport(rawData) {
    const payload = rawData.data || rawData;
    if (!payload || !payload.cbrSubreports) return [];
    const flatList = [];
    payload.cbrSubreports.forEach(subreport => {
        const sectionData = subreport[1];
        if (sectionData && sectionData.prRows) {
            sectionData.prRows.forEach(row => flatList.push({ account: row.prrName, amount: formatHledgerAmount(row.prrTotal) }));
        }
    });
    return flatList;
}

function adaptPeriodicReport(rawData) {
    const payload = rawData.data || rawData;
    if (!payload || !payload.prRows || payload.prRows.length === 0) return null;
    const headers = ["Account"];
    if (payload.prDates && payload.prDates.length > 0) {
        payload.prDates.forEach(datePair => {
            const startDate = datePair[0]?.contents || "";
            const endDate = datePair[1]?.contents || startDate;
            headers.push(startDate === endDate ? startDate : `${startDate} to ${endDate}`);
        });
    }
    headers.push("Total");
    const rows = [];
    payload.prRows.forEach(prRow => {
        const rowData = [prRow.prrName || ""];
        if (Array.isArray(prRow.prrAmounts)) {
            prRow.prrAmounts.forEach(amtList => rowData.push(Array.isArray(amtList) && amtList.length > 0 ? formatHledgerAmount(amtList[0]) : ""));
        }
        rowData.push(formatHledgerAmount(prRow.prrTotal));
        rows.push(rowData);
    });
    return { type: "table", columns: headers, rows };
}

const reportStrategies = {
    balance: (data) => renderTree(buildTreeFromFlatList(adaptBalanceReport(data))),
    register: (data) => renderUniversalTable(adaptGenericListToTable(adaptRegisterReport(data))),
    balancesheet: (data) => { const flat = adaptBalanceSheetReport(data); return flat.length === 0 ? renderText("No data found.") : renderTree(buildTreeFromFlatList(flat)); },
    incomestatement: (data) => { const flat = adaptBalanceSheetReport(data); return flat.length === 0 ? renderText("No data found.") : renderTree(buildTreeFromFlatList(flat)); },
    cashflow: (data) => { const flat = adaptBalanceSheetReport(data); return flat.length === 0 ? renderText("No data found.") : renderTree(buildTreeFromFlatList(flat)); },
    budget: (data) => { const tableData = adaptPeriodicReport(data); return !tableData ? renderText("No budget data found.") : renderUniversalTable(tableData); },
    accounts: (data) => renderUniversalTable(adaptGenericListToTable(data)),
    payees: (data) => renderUniversalTable(adaptGenericListToTable(data)),
    printtext: (data) => renderText(data),
    print: (data) => renderText(data),
    check: (data) => renderText(data),
};

// --- File Management UI Wrappers --------------------------------------

function syncFilesystem() {
    const files = StorageManager.listLocalFiles();
    files.forEach(f => {
        const content = StorageManager.getLocalFile(f) || "";
        session.fs.setFile(f, content);
    });
    return files;
}

function updateStartupSelector() {
    const startupList = document.getElementById("startup-file-list");
    if (!startupList) return;

    startupList.innerHTML = "";

    const localFiles = StorageManager.listLocalFiles();
    const driveNames = driveFilesList.map(f => f.name);
    const allFiles = Array.from(new Set([...localFiles, ...driveNames])).sort();

    if (allFiles.length === 0) {
        startupList.innerHTML = '<div class="file-list-item empty-state">-- No files available --</div>';
        return;
    }

    allFiles.forEach(f => {
        const item = document.createElement("div");
        item.className = "file-list-item";
        item.textContent = f;

        // Let the list item open the file instantly
        item.addEventListener("click", async () => {
            const startupModal = document.getElementById("startup-modal");
            startupModal.close();

            fileSelector.value = f;
            state.currentFilename = f;

            const content = StorageManager.getLocalFile(f) || "";
            commitFileState(f, content, false);
            enforceFileLockdown();
            await reparse();
        });

        startupList.appendChild(item);
    });
}

function updateFileSelector() {
    const localFiles = StorageManager.listLocalFiles();
    const driveNames = driveFilesList.map(f => f.name);
    const allFiles = Array.from(new Set([...localFiles, ...driveNames])).sort();

    fileSelector.innerHTML = '<option value="">-- No file selected --</option>';
    allFiles.forEach(f => {
        const opt = document.createElement("option");
        opt.value = f; opt.textContent = f;
        fileSelector.appendChild(opt);
    });
    if (state.currentFilename) fileSelector.value = state.currentFilename;

    updateStartupSelector();
}


function enforceFileLockdown() {
    const hasFile = !!state.currentFilename;

    journalText.disabled = !hasFile;
    document.getElementById("addtxnbtn").disabled = !hasFile;
    document.getElementById("importcsvbtn").disabled = !hasFile;

    // Toggle Visibility
    renameFileBtn.style.display = hasFile ? "" : "none";
    deleteFileBtn.style.display = hasFile ? "" : "none";

    if (!hasFile) {
        journalText.value = "Please create or select a journal file to begin.";
        guiPanel.innerHTML = '<span>Please create or select a journal file to begin.</span>';
        output.value = "Waiting for a journal to load.";
        setReportButtonsEnabled(false);
    }
}

fileSelector.addEventListener("change", async (e) => {
    const selected = e.target.value;
    if (!selected) {
        state.currentFilename = null;
        enforceFileLockdown();
        return;
    }
    state.currentFilename = selected;
    const content = StorageManager.getLocalFile(selected) || "";
    commitFileState(selected, content, false);
    enforceFileLockdown();
    await reparse();
});

newFileBtn.addEventListener("click", () => {
    newFilenameInput.value = "";
    newFileModal.showModal();
});

cancelNewFileBtn.addEventListener("click", () => newFileModal.close());

createFileBtn.addEventListener("click", async () => {
    let name = newFilenameInput.value.trim();
    if (!name) return;
    if (!name.endsWith(".journal")) name += ".journal";

    if (StorageManager.getLocalFile(name) !== null) {
        alert("A file with this name already exists.");
        return;
    }

    state.currentFilename = name;
    commitFileState(name, "", true);

    updateFileSelector();
    enforceFileLockdown();
    newFileModal.close();
    await reparse();
});

// --- Rename Flow ---
renameFileBtn.addEventListener("click", () => {
    renameFilenameInput.value = state.currentFilename;
    renameFileModal.showModal();
});

cancelRenameFileBtn.addEventListener("click", () => renameFileModal.close());

submitRenameFileBtn.addEventListener("click", async () => {
    let newName = renameFilenameInput.value.trim();
    if (!newName) return;
    if (!newName.endsWith(".journal")) newName += ".journal";

    if (newName === state.currentFilename) {
        renameFileModal.close();
        return;
    }
    if (StorageManager.getLocalFile(newName) !== null) {
        alert("A file with this name already exists.");
        return;
    }

    const oldName = state.currentFilename;
    const content = StorageManager.getLocalFile(oldName) || "";

    setStatus("Renaming file...", "loading");

    // 1. Memory VFS Sync
    session.fs.setFile(newName, content);
    session.fs.deleteFile(oldName);

    // 2. Local Storage Sync
    StorageManager.renameLocalFile(oldName, newName);

    // 3. Google Drive Native Rename (PATCH metadata)
    const driveFile = driveFilesList.find(f => f.name === oldName);
    if (driveFile && StorageManager.accessToken) {
        try {
            await StorageManager.renameInDrive(driveFile.id, newName);
            driveFile.name = newName;
            driveFile.modifiedTime = new Date().toISOString();
        } catch (e) {
            console.error("Failed to rename in Drive", e);
        }
    } else if (driveFile) {
        driveFile.name = newName; // optimistic update
    }

    // Handle in-progress debounced queues
    if (driveSyncQueue.has(oldName)) {
        driveSyncQueue.set(newName, driveSyncQueue.get(oldName));
        driveSyncQueue.delete(oldName);
    }

    state.currentFilename = newName;
    updateFileSelector();
    enforceFileLockdown();
    renameFileModal.close();
    setStatus("File renamed successfully.", "ok");

    await reparse();
});

// --- Delete Flow ---
deleteFileBtn.addEventListener("click", async () => {
    if (!confirm(`Are you sure you want to delete ${state.currentFilename}? This will permanently remove it from local storage and Google Drive.`)) return;

    const targetName = state.currentFilename;
    setStatus("Deleting file...", "loading");

    // 1. Memory VFS Sync
    session.fs.deleteFile(targetName);

    // 2. Local Storage Sync
    StorageManager.deleteLocalFile(targetName);

    // 3. Google Drive Native Delete
    const driveFileIndex = driveFilesList.findIndex(f => f.name === targetName);
    if (driveFileIndex > -1) {
        const driveFile = driveFilesList[driveFileIndex];
        if (StorageManager.accessToken) {
            try {
                await StorageManager.deleteFromDrive(driveFile.id);
            } catch (e) {
                console.error("Failed to delete from Drive", e);
            }
        }
        driveFilesList.splice(driveFileIndex, 1);
    }

    // Cancel any pending writes for this file
    driveSyncQueue.delete(targetName);

    // Resolve UI State
    const remainingFiles = StorageManager.listLocalFiles();
    state.currentFilename = remainingFiles.length > 0 ? remainingFiles[0] : null;

    updateFileSelector();
    if (state.currentFilename) {
        const content = StorageManager.getLocalFile(state.currentFilename) || "";
        commitFileState(state.currentFilename, content, false);
        enforceFileLockdown();
        await reparse();
    } else {
        enforceFileLockdown();
    }

    setStatus("File deleted successfully.", "ok");
});

// --- Global UI Behaviors --------------------------------------------

closeStatusModalBtn.addEventListener("click", () => statusModal.close());

function syncUIState() {
    inputView.style.display = state.view === "input" ? "flex" : "none";
    outputView.style.display = state.view === "output" ? "flex" : "none";
    viewToggleButton.textContent = state.view === "input" ? "Output" : "Input";

    guiToggle.checked = state.isGui;
    if (state.isGui) {
        journalPanel.style.display = "none"; guiPanel.style.display = "flex";
        output.style.display = "none"; guiOutputPanel.style.display = "flex";
    } else {
        guiPanel.style.display = "none"; journalPanel.style.display = "flex";
        guiOutputPanel.style.display = "none"; output.style.display = "";
    }
    closeRightMenuOnMobile();
}

async function syncJournalTextToState() {
    const printResult = await session.printText("");
    let newText = "";
    if (printResult && typeof printResult.data === 'string') newText = printResult.data;
    else if (printResult) newText = String(printResult);

    commitFileState(state.currentFilename, newText, true);

    syncUIState();
    await reparse();
}

// --- GUI Input Journal Renderer -------------------------------------
async function renderGuiJournal() {
    if (!session.isLoaded || !state.currentFilename) return;
    guiPanel.innerHTML = '<div class="status-banner" data-state="loading" style="position: static; margin-top: 20px;"><span class="status-dot"></span><span>Loading GUI view...</span></div>';

    try {
        const result = await session.getJournalJSON();
        if (!result.ok) {
            guiPanel.innerHTML = `<div class="status-banner" data-state="error" style="position: static; margin-top: 20px;"><span class="status-dot"></span><span>${escapeHtml(result.error)}</span></div>`;
            return;
        }
        if (!result.data || result.data.length === 0) {
            guiPanel.innerHTML = '<div class="status-banner" data-state="info" style="position: static; margin-top: 20px;"><span class="status-dot"></span><span>No transactions found.</span></div>';
            return;
        }
        guiPanel.innerHTML = "";
        console.log(result);
        result.data.forEach(txn => guiPanel.appendChild(renderTransactionCard(txn)));
    } catch (error) {
        guiPanel.innerHTML = `<div class="status-banner" data-state="error" style="position: static; margin-top: 20px;"><span class="status-dot"></span><span>Failed to load GUI view</span></div>`;
    }
}

function renderTransactionCard(txn) {
    const card = document.createElement("div");
    card.className = "txn-card";

    const postingsHtml = txn.postings.map(p => {
        let colorClass = 'neutral';
        if (p.amount) colorClass = p.amount.includes('-') ? 'debit' : 'credit';
        return `<div class="posting-item ${colorClass}">
                  <span class="posting-account">${escapeHtml(p.account)}</span>
                  <span class="posting-amount">${escapeHtml(p.amount || '')}</span>
                </div>`;
    }).join("");

    card.innerHTML = `
        <div class="txn-content">
          <div class="txn-main">
            <div class="txn-info">
              <div class="txn-title-row">
                <span class="txn-desc">${escapeHtml(txn.description)}</span>
                <span class="txn-date">${escapeHtml(txn.date)}</span>
              </div>
            </div>
          </div>
          <div class="posting-list">${postingsHtml}</div>
        </div>
        <div class="txn-actions-container">
          <button class="secondary edit-btn" data-id="${txn.id}">Edit</button>
          <button class="secondary delete-btn" data-id="${txn.id}" style="color: #900c0c; border-color: #f5c2c2; background: #fdf2f2;">Delete</button>
        </div>`;

    card.querySelector(".edit-btn").addEventListener("click", () => {
        editingTxnId = txn.id;
        modalTitle.textContent = "Edit Transaction";
        submitTxnBtn.textContent = "Save Changes";
        txnDate.value = txn.date;
        txnDesc.value = txn.description;
        postingsContainer.innerHTML = "";

        txn.postings.forEach(p => {
            const row = document.createElement("div"); row.className = "posting-row";
            row.style.cssText = "display: grid; grid-template-columns: 2fr 1fr auto; gap: 8px; align-items: center;";
            row.innerHTML = `<input type="text" class="post-acct" placeholder="Account" value="${escapeHtml(p.account)}" required />
                           <input type="text" class="post-amt" placeholder="Amount" value="${escapeHtml(p.amount || '')}" />
                           <button type="button" class="secondary remove-post-btn" style="padding: 0 8px; min-height: 34px; color: #900c0c;">×</button>`;
            attachRemoveRowListener(row.querySelector(".remove-post-btn"));
            postingsContainer.appendChild(row);
        });

        rawTxnInput.value = txn.rawText; rawToggle.checked = false;
        visualTxnUi.style.display = "block"; rawTxnContainer.style.display = "none";
        setStatus("Edit transaction details", "info", modalStatusBanner);
        txnModal.showModal();
    });

    card.querySelector(".delete-btn").addEventListener("click", async () => {
        if (!confirm("Are you sure you want to delete this transaction?")) return;
        setStatus("Deleting transaction...", "loading");
        try {
            const result = await session.deleteTransaction(txn.id);
            if (result && result.error) { setStatus(`Error: ${result.error}`, "error"); return; }
            await syncJournalTextToState();
            setStatus("Transaction deleted successfully.", "ok");
        } catch (error) { setStatus("Failed to delete transaction.", "error"); }
    });

    let startX = 0, startY = 0;

    card.addEventListener("touchstart", (e) => {
        if (window.innerWidth > 780) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
    }, { passive: true });

    card.addEventListener("touchend", (e) => {
        if (window.innerWidth > 780) return;
        const diffX = startX - e.changedTouches[0].clientX;
        const diffY = startY - e.changedTouches[0].clientY;

        // Ensure it's an intentional horizontal swipe, not vertical scrolling (> 40px)
        if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 40) {
            if (diffX > 0) {
                // Swipe Left (Reveal)
                if (activeTxnCard && activeTxnCard !== card) {
                    activeTxnCard.classList.remove("show-actions");
                }
                card.classList.add("show-actions");
                activeTxnCard = card;
            } else {
                // Swipe Right (Hide)
                card.classList.remove("show-actions");
                if (activeTxnCard === card) activeTxnCard = null;
            }
        }
    });

    // Hide controls when tapping anywhere on the card (unless tapping the buttons)
    card.addEventListener("click", (e) => {
        if (window.innerWidth <= 780 && card.classList.contains("show-actions")) {
            if (!e.target.closest(".txn-actions-container")) {
                card.classList.remove("show-actions");
                activeTxnCard = null;
            }
        }
    });
    return card;
}

// --- Reparse Engine -------------------------------------------------
let debounceTimer = null;

function scheduleReparse() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(reparse, 300);
}

async function reparse() {
    if (!state.currentFilename) return;
    setReportButtonsEnabled(false);

    const forecast = forecastToggle.checked;
    const result = await session.loadJournal(journalText.value, forecast);

    if (result.ok) {
        if (statusBanner.dataset.state === "error") {
            setStatus("Journal Loaded", "info"); // Clear the error status smoothly without "Ready" spam
        }
        if (state.isGui) await renderGuiJournal();
    } else {
        setStatus(`Journal error: ${result.error}`, "error");
        if (state.isGui) guiPanel.innerHTML = `<div class="status-banner" data-state="error" style="position: static; margin-top: 20px;"><span class="status-dot"></span><span>${escapeHtml(result.error)}</span></div>`;
    }
    setReportButtonsEnabled(session.isLoaded);
}

// --- CSV Import Handlers --------------------------------------------
function setupFileReader(inputId, textareaId) {
    document.getElementById(inputId).addEventListener("change", function (e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (e) { document.getElementById(textareaId).value = e.target.result; };
        reader.readAsText(file);
    });
}

setupFileReader("csv-file-input", "csv-import-text");
setupFileReader("rules-file-input", "csv-import-rules");

csvImportBtn.addEventListener("click", () => csvModal.showModal());
csvCancelBtn.addEventListener("click", () => csvModal.close());

async function processCsvImport(mode) {
    const csvData = document.getElementById("csv-import-text").value;
    const rulesData = document.getElementById("csv-import-rules").value;
    const forecast = forecastToggle.checked;
    const modalBanner = document.getElementById("csv-modal-status");

    csvAppendBtn.disabled = true; csvReplaceBtn.disabled = true; csvCancelBtn.disabled = true;
    setStatus("Parsing CSV data...", "loading", modalBanner);

    try {
        const result = await session.parseCsv(csvData, rulesData, forecast);
        if (!result.ok) {
            setStatus(`Error: ${result.error}`, "error", modalBanner);
            csvAppendBtn.disabled = false; csvReplaceBtn.disabled = false; csvCancelBtn.disabled = false; return;
        }
        const printResult = await session.printText("");
        let newJournalText = "";
        if (printResult && typeof printResult.data === 'string') newJournalText = printResult.data;
        else if (printResult) newJournalText = String(printResult);

        if (mode === 'append') {
            const currentText = journalText.value.trim();
            const finalMergedContent = currentText ? currentText + "\n\n" + newJournalText : newJournalText;
            commitFileState(state.currentFilename, finalMergedContent, true);
        } else {
            commitFileState(state.currentFilename, newJournalText, true);
        }

        await reparse();
        setStatus("Import successful.", "ok", modalBanner);

        setTimeout(() => {
            csvModal.close(); closeRightMenuOnMobile();
            setStatus("Provide CSV data and rules", "info", modalBanner);
            csvAppendBtn.disabled = false; csvReplaceBtn.disabled = false; csvCancelBtn.disabled = false;
        }, 500);
    } catch (err) {
        setStatus(`Import failed: ${err.message}`, "error", modalBanner);
        csvAppendBtn.disabled = false; csvReplaceBtn.disabled = false; csvCancelBtn.disabled = false;
    }
}

csvAppendBtn.addEventListener("click", () => processCsvImport('append'));
csvReplaceBtn.addEventListener("click", () => processCsvImport('replace'));

// --- Standard Event Handlers ----------------------------------------
guiToggle.addEventListener("change", async () => {
    state.isGui = guiToggle.checked; syncUIState();
    if (state.isGui) await renderGuiJournal();
});

viewToggleButton.addEventListener("click", () => {
    state.view = state.view === "input" ? "output" : "input"; syncUIState();
});

function openRightMenuOnMobile() { mainContent.classList.add("show-right-pane"); }
function closeRightMenuOnMobile() { mainContent.classList.remove("show-right-pane"); }

if (mobileMenuBtn && mobileCloseBtn) {
    mobileMenuBtn.addEventListener("click", openRightMenuOnMobile);
    mobileCloseBtn.addEventListener("click", closeRightMenuOnMobile);
}

journalText.addEventListener("input", () => {
    commitFileState(state.currentFilename, journalText.value, true);
    scheduleReparse();
});

forecastToggle.addEventListener("change", reparse);

clearButton.addEventListener("click", () => {
    output.value = ""; guiOutputPanel.innerHTML = "";
    setStatus("Output cleared.", "info"); state.view = "output"; syncUIState();
});

// --- Settings Event Handlers ----------------------------------------
settingsBtn.addEventListener("click", () => {
    settingDarkMode.checked = document.documentElement.classList.contains("dark-mode");
    settingsModal.showModal();
});
closeSettingsModal.addEventListener("click", () => settingsModal.close());

settingDarkMode.addEventListener("change", (e) => {
    if (e.target.checked) document.documentElement.classList.add("dark-mode");
    else document.documentElement.classList.remove("dark-mode");
});

settingFontSize.addEventListener("input", (e) => {
    const size = e.target.value;
    document.documentElement.style.setProperty('--base-font-size', `${size}px`);
    fontSizeDisplay.textContent = `${size}px`;
    localStorage.setItem('wedger_font_size', size);
});

const savedSize = localStorage.getItem('wedger_font_size');
if (savedSize) {
    settingFontSize.value = savedSize;
    document.documentElement.style.setProperty('--base-font-size', `${savedSize}px`);
    if (fontSizeDisplay) fontSizeDisplay.textContent = `${savedSize}px`;
}

settingHideBanner.addEventListener("change", (e) => {
    if (e.target.checked) { statusBanner.style.display = 'none'; document.body.style.paddingTop = '0'; mainContent.style.height = '100dvh'; }
    else { statusBanner.style.display = 'flex'; document.body.style.paddingTop = 'calc(2.4vw + 1px)'; mainContent.style.height = 'calc(100dvh - (2.4vw + 1px))'; }
});

// --- Transaction Modal Handler --------------------------------------
function buildTransactionText() {
    const dateVal = txnDate.value, descVal = txnDesc.value.trim();
    const postingRows = postingsContainer.querySelectorAll(".posting-row");
    let rawTxnText = `${dateVal} ${descVal}`;
    for (const row of postingRows) {
        const acct = row.querySelector(".post-acct").value.trim();
        const amt = row.querySelector(".post-amt").value.trim();
        if (acct) {
            rawTxnText += `\n    ${acct}`;
            if (amt) rawTxnText += `    ${amt}`;
        }
    }
    return rawTxnText;
}

rawToggle.addEventListener("change", () => {
    if (rawToggle.checked) {
        rawTxnInput.value = buildTransactionText();
        visualTxnUi.style.display = "none"; rawTxnContainer.style.display = "grid";
    } else {
        visualTxnUi.style.display = "block"; rawTxnContainer.style.display = "none";
    }
});

document.getElementById("addtxnbtn").addEventListener("click", () => {
    editingTxnId = null; modalTitle.textContent = "Add New Transaction"; submitTxnBtn.textContent = "Add Transaction";
    txnDate.value = new Date().toISOString().split("T")[0]; txnDesc.value = ""; postingsContainer.innerHTML = "";

    const defaultRows = [{ acct: "", placeholder: "Account (e.g. expenses:food)" }, { acct: "", placeholder: "Account (e.g. assets:bank)" }];
    defaultRows.forEach(def => {
        const row = document.createElement("div"); row.className = "posting-row";
        row.style.cssText = "display: grid; grid-template-columns: 2fr 1fr auto; gap: 8px; align-items: center;";
        row.innerHTML = `<input type="text" class="post-acct" placeholder="${def.placeholder}" required />
                         <input type="text" class="post-amt" placeholder="Amount (optional)" />
                         <button type="button" class="secondary remove-post-btn" style="padding: 0 8px; min-height: 34px; color: #900c0c;">×</button>`;
        attachRemoveRowListener(row.querySelector(".remove-post-btn"));
        postingsContainer.appendChild(row);
    });
    rawToggle.checked = false; visualTxnUi.style.display = "block"; rawTxnContainer.style.display = "none"; rawTxnInput.value = "";
    setStatus("Fill in transaction details", "info", modalStatusBanner);
    txnModal.showModal();
});

function attachRemoveRowListener(btn) {
    btn.addEventListener("click", (e) => {
        const row = e.target.closest(".posting-row");
        if (postingsContainer.children.length > 2) row.remove();
        else setStatus("A transaction must have at least 2 postings.", "error", modalStatusBanner);
    });
}

addPostingBtn.addEventListener("click", () => {
    const row = document.createElement("div"); row.className = "posting-row";
    row.style.cssText = "display: grid; grid-template-columns: 2fr 1fr auto; gap: 8px; align-items: center;";
    row.innerHTML = `<input type="text" class="post-acct" placeholder="Account (e.g. expenses:food)" required />
                       <input type="text" class="post-amt" placeholder="Amount (optional)" />
                       <button type="button" class="secondary remove-post-btn" style="padding: 0 8px; min-height: 34px; color: #900c0c;">×</button>`;
    attachRemoveRowListener(row.querySelector(".remove-post-btn"));
    postingsContainer.appendChild(row);
});

cancelTxnBtn.addEventListener("click", () => txnModal.close());

submitTxnBtn.addEventListener("click", async () => {
    let rawTxnText = "";
    if (rawToggle.checked) {
        rawTxnText = rawTxnInput.value.trim();
        if (!rawTxnText) { setStatus("Transaction text cannot be empty.", "error", modalStatusBanner); return; }
    } else {
        const dateVal = txnDate.value, descVal = txnDesc.value.trim();
        if (!dateVal || !descVal) { setStatus("Please fill in Date and Description.", "error", modalStatusBanner); return; }
        const postingRows = postingsContainer.querySelectorAll(".posting-row");
        if (postingRows.length < 2) { setStatus("A transaction requires at least 2 postings.", "error", modalStatusBanner); return; }
        for (const row of postingRows) {
            if (!row.querySelector(".post-acct").value.trim()) { setStatus("All posting rows must have an account specified.", "error", modalStatusBanner); return; }
        }
        rawTxnText = buildTransactionText();
    }

    setStatus(editingTxnId !== null ? "Saving changes..." : "Adding transaction...", "loading", modalStatusBanner);
    setReportButtonsEnabled(false);

    try {
        let result = editingTxnId !== null ? await session.updateTransaction(editingTxnId, rawTxnText) : await session.balanceTransaction(rawTxnText);
        if (result && result.error) { setStatus(`Error: ${result.error}`, "error", modalStatusBanner); setReportButtonsEnabled(true); return; }
        await syncJournalTextToState();
        setStatus(editingTxnId !== null ? "Transaction updated successfully." : "Transaction added successfully.", "ok");
        txnModal.close();
    } catch (error) {
        console.error(error); setStatus("Failed to process transaction.", "error", modalStatusBanner); setReportButtonsEnabled(true);
    }
});

// --- Report Builder Setup --------------------------------------
const reportGroups = [
    { label: "Validate", items: [{ id: "check", label: "Check", run: (q) => checkStrictToggle.checked ? session.checkStrict(q) : session.check(q) }] },
    { label: "Listings", items: [{ id: "accounts", label: "Accounts", run: (q) => session.accounts(q) }, { id: "payees", label: "Payees", run: (q) => session.payees(q) }, { id: "commodities", label: "Commodities", run: (q) => session.commodities(q) }, { id: "tags", label: "Tags", run: (q) => session.tags(q) }] },
    { label: "Reports", items: [{ id: "balance", label: "Balance", run: (q) => session.balance(q) }, { id: "register", label: "Register", run: (q) => session.register(q) }, { id: "print", label: "Print", run: (q) => session.print(q) }, { id: "prices", label: "Prices", run: (q) => session.prices(q) }] },
    { label: "Statements", items: [{ id: "balancesheet", label: "Balance sheet", run: (q) => session.balancesheet(q) }, { id: "incomestatement", label: "Income statement", run: (q) => session.incomestatement(q) }, { id: "cashflow", label: "Cash flow", run: (q) => session.cashflow(q) }, { id: "budget", label: "Budget report", run: (q) => session.budget(q) }] },
    { label: "Export", items: [{ id: "printtext", label: ".journal", run: (q) => session.printText(q) }] },
];

const reportButtons = [];
for (const group of reportGroups) {
    const groupEl = document.createElement("div"); groupEl.className = "report-group";
    const labelEl = document.createElement("div"); labelEl.className = "report-group-label"; labelEl.textContent = group.label; groupEl.appendChild(labelEl);
    const buttonsEl = document.createElement("div"); buttonsEl.className = "buttons";
    for (const item of group.items) {
        const btn = document.createElement("button"); btn.id = item.id; btn.textContent = item.label; btn.disabled = true;
        btn.addEventListener("click", () => {
            if (!session.isLoaded || !state.currentFilename) { setStatus("No valid journal loaded.", "error"); return; }
            runReport(item.id, item.label, () => item.run(queryInput.value));
        });
        buttonsEl.appendChild(btn); reportButtons.push(btn);
    }
    groupEl.appendChild(buttonsEl); reportGroupsContainer.appendChild(groupEl);
}

function setReportButtonsEnabled(enabled) {
    for (const btn of reportButtons) {
        if (!state.currentFilename) btn.disabled = true; else btn.disabled = !enabled;
    }
}

async function runReport(reportId, label, action) {
    state.view = "output"; syncUIState(); setReportButtonsEnabled(false);
    setStatus(`Running ${label}...`, "loading");
    try {
        const result = await action();
        output.value = (result && typeof result.data === 'string') ? result.data : JSON.stringify(result, null, 2);
        guiOutputPanel.innerHTML = "";
        const strategy = reportStrategies[reportId] || smartRender;
        guiOutputPanel.appendChild(strategy(result));
        setStatus(`${label} report finished.`, "ok");
    } catch (error) {
        output.value = error.stack || String(error);
        guiOutputPanel.innerHTML = `<div class="status-banner" data-state="error" style="position: static; margin-top: 20px;"><span class="status-dot"></span><span>Error running ${label}: ${escapeHtml(error.message || String(error))}</span></div>`;
        setStatus(`${label} report failed.`, "error");
    } finally { setReportButtonsEnabled(session.isLoaded); }
}


// --- Init -----------------------------------------------------------
setStatus("Initializing WASM module...", "loading");
const session = await HledgerSession.init();
window.session = session;

const files = syncFilesystem();
updateFileSelector();

const startupModal = document.getElementById("startup-modal");
const startupNewBtn = document.getElementById("startup-new-btn");

enforceFileLockdown();
syncUIState();

// Check if we have files to show, otherwise go straight to the "New File" modal
if (files.length === 0) {
    state.currentFilename = null;
    setTimeout(() => newFileModal.showModal(), 500);
    setStatus("Ready", "ok");
} else if (files.length === 1) {
    // Automatically open the file if there is only one available
    state.currentFilename = files[0];
    fileSelector.value = state.currentFilename;

    const content = StorageManager.getLocalFile(state.currentFilename) || "";
    commitFileState(state.currentFilename, content, false);
    enforceFileLockdown();
    await reparse();
    setStatus("Ready", "ok");
} else {
    // Show the startup modal if there are multiple files to choose from
    state.currentFilename = null;
    setTimeout(() => startupModal.showModal(), 500);
    setStatus("Ready", "ok");
}

// Handle creating a new file from the startup modal
startupNewBtn.addEventListener("click", () => {
    startupModal.close();
    newFilenameInput.value = "";
    newFileModal.showModal();
});

// Dismiss the full screen loading overlay now that everything has spun up completely.
const globalOverlay = document.getElementById("loading-overlay");
if (globalOverlay) {
    globalOverlay.style.opacity = "0";
    globalOverlay.style.visibility = "hidden";
    setTimeout(() => globalOverlay.remove(), 400); // 400ms matching css transition
}