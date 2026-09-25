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



const { HledgerSession } = await import(`${libBaseUrl}js/hledger.js`);
import { StorageManager } from "./storage.js";
import { state } from "./state.js";


let editingTxnId = null;
let driveSyncTimer = null;
const driveSyncQueue = new Map(); // filename -> content queue for debouncing
let isDriveSyncing = false;
//let driveFilesList = []; // Array of synced file objects

// --- Element Selectors ----------------------------------------------



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
    if (state.files.active === filename && journalText.value !== content) {
        journalText.value = content;
    }

    // 2. Synchronous Virtual FS update
    state.hledger.session.fs.setFile(filename, content);

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
            const driveFile = state.files.list.get(filename);
            const fileId = driveFile ? driveFile.driveId : null;

            const res = await StorageManager.saveToDrive(filename, content, fileId);
            state.files.list.markSynced(filename, { driveId: res.id, modifiedTime: new Date().toISOString() });
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
                    StorageManager.accessToken = null;
                    state.user = null;
                    state.ui.status = { text: "Session expired. Please sign in to sync.", type: "error", banner: statusBanner };
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
        state.ui.status = { text: "Changes synced to Drive.", type: "ok", banner: statusBanner };
    }
}

StorageManager.init(async (user) => {
    applyAuthenticatedState(user);
    await performInitialSync();
});

googleLoginBtn.addEventListener("click", () => StorageManager.promptLogin());

function applyAuthenticatedState(user) {
    state.user = user;
}

logoutBtn.addEventListener("click", () => {
    StorageManager.logout();
    state.user = null;
    driveSyncQueue.clear();

    profileModal.close();
    state.files.active = null;
    state.files.list.refresh([]); // strips Drive metadata, keeps files as local-only
    journalText.value = "";

    state.ui.status = { text: "Logged out successfully.", type: "info", banner: statusBanner };
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
        state.ui.status = { text: "Syncing all Google Drive files...", type: "loading", banner: statusBanner };

        const syncedResults = await StorageManager.syncAllDriveFiles();
        //driveFilesList = syncedResults.filter(f => f.status === "synced" || f.status === "synced_local_newer");

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

        state.files.list.refresh(syncedResults.filter(f => f.status === "synced" || f.status === "synced_local_newer"));
        //updateFileSelector();

        if (!state.files.active && syncedResults.length > 0) {
            state.files.active = syncedResults[0].name;
        }

        if (state.files.active) {
            const content = StorageManager.getLocalFile(state.files.active) || "";
            commitFileState(state.files.active, content, false);
            //enforceFileLockdown();
            await reparse();
        } else {
            //enforceFileLockdown();
        }

        state.ui.status = { text: "All Drive files synced smoothly.", type: "ok", banner: statusBanner };
    } catch (e) {
        console.error("Initial Sync Error:", e);
        if (e.message === "401" || e.message.includes("401")) {
            state.user = null;
            state.ui.status = { text: "Session expired. Working offline.", type: "error", banner: statusBanner };
        } else {
            state.ui.status = { text: "Drive sync failed. Working offline.", type: "error", banner: statusBanner };
        }

        // Ensure local files are loaded anyway
        //updateFileSelector();
        state.files.list.refresh();
        const localFiles = StorageManager.listLocalFiles();
        if (!state.files.active && localFiles.length > 0) {
            state.files.active = localFiles[0];
        }

        if (state.files.active) {
            const content = StorageManager.getLocalFile(state.files.active) || "";
            commitFileState(state.files.active, content, false);
            //enforceFileLockdown();
            await reparse();
        } else {
            //enforceFileLockdown();
        }
    }
}

function updateProfileModalUI() {
    const filesListEl = document.getElementById("synced-files-list");
    const driveFiles = state.files.list.all.filter(f => f.driveId);

    if (filesListEl) {
        if (driveFiles.length === 0) {
            filesListEl.innerHTML = `<div style="padding: 12px; font-family: var(--mono); font-size: 11px; color: var(--ink-soft); text-align: center;">No Drive files found.</div>`;
        } else {
            filesListEl.innerHTML = driveFiles.map(f => `
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
        state.hledger.session.fs.setFile(f, content);
    });
    state.files.list.refresh(); // populates the list, fires "files:changed"
    return files;
}

function renderFileMenus() {
    const list = state.files.list.all;
    const active = state.files.active;

    fileSelector.innerHTML = '<option value="">-- No file selected --</option>';
    list.forEach(f => {
        const opt = document.createElement("option");
        opt.value = f.name; opt.textContent = f.name;
        fileSelector.appendChild(opt);
    });
    fileSelector.value = active || "";

    const startupList = document.getElementById("startup-file-list");
    if (!startupList) return;
    startupList.innerHTML = list.length === 0
        ? '<div class="file-list-item empty-state">-- No files available --</div>'
        : "";
    list.forEach(f => {
        const item = document.createElement("div");
        item.className = "file-list-item";
        item.textContent = f.name;
        item.addEventListener("click", async () => {
            document.getElementById("startup-modal").close();
            state.files.active = f.name;
            commitFileState(f.name, StorageManager.getLocalFile(f.name) || "", false);
            await reparse();
        });
        startupList.appendChild(item);
    });
}

document.addEventListener("files:changed", renderFileMenus);


//function enforceFileLockdown() {  
//}

fileSelector.addEventListener("change", async (e) => {
    const selected = e.target.value;
    if (!selected) {
        state.files.active = null;
        //enforceFileLockdown();
        return;
    }
    state.files.active = selected;
    const content = StorageManager.getLocalFile(selected) || "";
    commitFileState(selected, content, false);
    //enforceFileLockdown();
    await reparse();
});

newFileBtn.addEventListener("click", () => {
    newFilenameInput.value = "";
    newFileModal.showModal();
});

cancelNewFileBtn.addEventListener("click", () => newFileModal.close());

createFileBtn.addEventListener("click", async () => {
    try {
        const entry = state.files.list.new(newFilenameInput.value);
        commitFileState(entry.name, "", true);
        newFileModal.close();
        await reparse();
    } catch (e) {
        alert(e.message);
    }
});

// --- Rename Flow ---
renameFileBtn.addEventListener("click", () => {
    renameFilenameInput.value = state.files.active;
    renameFileModal.showModal();
});

cancelRenameFileBtn.addEventListener("click", () => renameFileModal.close());

submitRenameFileBtn.addEventListener("click", async () => {
    const oldName = state.files.active;
    let updated;
    try {
        updated = state.files.list.rename(oldName, renameFilenameInput.value);
    } catch (e) {
        alert(e.message);
        return;
    }
    if (updated.name === oldName) { renameFileModal.close(); return; }

    state.ui.status = { text: "Renaming file...", type: "loading", banner: statusBanner };

    if (updated.driveId && StorageManager.accessToken) {
        try {
            await StorageManager.renameInDrive(updated.driveId, updated.name);
            state.files.list.markSynced(updated.name, { modifiedTime: new Date().toISOString() });
        } catch (e) {
            console.error("Failed to rename in Drive", e);
        }
    }

    if (driveSyncQueue.has(oldName)) {
        driveSyncQueue.set(updated.name, driveSyncQueue.get(oldName));
        driveSyncQueue.delete(oldName);
    }

    renameFileModal.close();
    state.ui.status = { text: "File renamed successfully.", type: "ok", banner: statusBanner };
    await reparse();
});

deleteFileBtn.addEventListener("click", async () => {
    const targetName = state.files.active;
    if (!confirm(`Are you sure you want to delete ${targetName}? This will permanently remove it from local storage and Google Drive.`)) return;

    state.ui.status = { text: "Deleting file...", type: "loading", banner: statusBanner };

    const entry = state.files.list.delete(targetName);

    if (entry?.driveId && StorageManager.accessToken) {
        try { await StorageManager.deleteFromDrive(entry.driveId); }
        catch (e) { console.error("Failed to delete from Drive", e); }
    }
    driveSyncQueue.delete(targetName);

    if (state.files.active) {
        const content = StorageManager.getLocalFile(state.files.active) || "";
        commitFileState(state.files.active, content, false);
        await reparse();
    }

    state.ui.status = { text: "File deleted successfully.", type: "ok", banner: statusBanner };
});

// --- Global UI Behaviors --------------------------------------------

closeStatusModalBtn.addEventListener("click", () => statusModal.close());

function syncUIState() {
    closeRightMenuOnMobile();
}

async function syncAfterTxnMutation(rawText) {
    commitFileState(state.files.active, rawText, true);
    syncUIState();
    if (state.ui.dataRendering) await renderGuiJournal();
    await refreshAccountSuggestions();
    state.ui.reportButtonsEnabled = state.hledger.session.isLoaded;
}

// --- GUI Input Journal Renderer -------------------------------------
async function renderGuiJournal() {
    if (!state.hledger.session.isLoaded || !state.files.active) return;
    guiPanel.innerHTML = '<div class="status-banner" data-state="loading" style="position: static; margin-top: 20px;"><span class="status-dot"></span><span>Loading GUI view...</span></div>';

    try {
        const result = await state.hledger.session.getJournalJSON();
        if (!result.ok) {
            guiPanel.innerHTML = `<div class="status-banner" data-state="error" style="position: static; margin-top: 20px;"><span class="status-dot"></span><span>${escapeHtml(result.error)}</span></div>`;
            return;
        }
        if (!result.data || result.data.length === 0) {
            guiPanel.innerHTML = '<div class="status-banner" data-state="info" style="position: static; margin-top: 20px;"><span class="status-dot"></span><span>No transactions found.</span></div>';
            return;
        }
        guiPanel.innerHTML = "";
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
            row.innerHTML = `<input type="text" class="post-acct" list="account-suggestions" placeholder="Account" value="${escapeHtml(p.account)}" required />
                           <input type="text" class="post-amt" placeholder="Amount" value="${escapeHtml(p.amount || '')}" />
                           <button type="button" class="secondary remove-post-btn" style="padding: 0 8px; min-height: 34px; color: #900c0c;">×</button>`;
            attachRemoveRowListener(row.querySelector(".remove-post-btn"));
            postingsContainer.appendChild(row);
        });

        rawTxnInput.value = txn.rawText; rawToggle.checked = false;
        visualTxnUi.style.display = "block"; rawTxnContainer.style.display = "none";
        state.ui.status = { text: "Edit transaction details", type: "info", banner: modalStatusBanner };
        txnModal.showModal();
    });

    card.querySelector(".delete-btn").addEventListener("click", async () => {
        if (!confirm("Are you sure you want to delete this transaction?")) return;
        state.ui.status = { text: "Deleting transaction...", type: "loading", banner: statusBanner };
        try {
            const result = await state.hledger.session.deleteTransaction(txn.id);
            if (result && result.error) { state.ui.status = { text: `Error: ${result.error}`, type: "error", banner: statusBanner }; return; }
            await syncAfterTxnMutation(result.rawText);
            state.ui.status = { text: "Transaction deleted successfully.", type: "ok", banner: statusBanner };
        } catch (error) { state.ui.status = { text: "Failed to delete transaction.", type: "error", banner: statusBanner }; }
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



async function refreshAccountSuggestions() {
    if (!state.hledger.session || !state.hledger.session.isLoaded) return;
    try {
        const result = await state.hledger.session.accounts();
        if (result && result.ok && Array.isArray(result.data)) {
            accountSuggestionsList.innerHTML = result.data
                .map(name => `<option value="${escapeHtml(name)}"></option>`)
                .join("");
        }
    } catch (error) {
        console.error("Failed to refresh account suggestions:", error);
    }
}
// --- Reparse Engine -------------------------------------------------
let debounceTimer = null;

function scheduleReparse() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(reparse, 300);
}

async function reparse() {
    if (!state.files.active) return;
    state.ui.reportButtonsEnabled = false;

    const forecast = forecastToggle.checked;
    const result = await state.hledger.session.loadJournal(journalText.value, forecast);

    if (result.ok) {
        if (statusBanner.dataset.state === "error") {
            state.ui.status = { text: "Journal Loaded", type: "info", banner: statusBanner }; // Clear the error status smoothly without "Ready" spam
        }
        if (state.ui.dataRendering) await renderGuiJournal();
        await refreshAccountSuggestions();
    } else {
        state.ui.status = { text: `Journal error: ${result.error}`, type: "error", banner: statusBanner };
        if (state.ui.dataRendering) guiPanel.innerHTML = `<div class="status-banner" data-state="error" style="position: static; margin-top: 20px;"><span class="status-dot"></span><span>${escapeHtml(result.error)}</span></div>`;
    }
    state.ui.reportButtonsEnabled = state.hledger.session.isLoaded;
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
    state.ui.status = { text: "Parsing CSV data...", type: "loading", banner: modalBanner };

    try {
        const result = await state.hledger.session.parseCsv(csvData, rulesData, forecast);
        if (!result.ok) {
            state.ui.status = { text: `Error: ${result.error}`, type: "error", banner: modalBanner };
            csvAppendBtn.disabled = false; csvReplaceBtn.disabled = false; csvCancelBtn.disabled = false; return;
        }
        const printResult = await state.hledger.session.printText("");
        let newJournalText = "";
        if (printResult && typeof printResult.data === 'string') newJournalText = printResult.data;
        else if (printResult) newJournalText = String(printResult);

        if (mode === 'append') {
            const currentText = journalText.value.trim();
            const finalMergedContent = currentText ? currentText + "\n\n" + newJournalText : newJournalText;
            commitFileState(state.files.active, finalMergedContent, true);
        } else {
            commitFileState(state.files.active, newJournalText, true);
        }

        await reparse();
        state.ui.status = { text: "Import successful.", type: "ok", banner: modalBanner };

        setTimeout(() => {
            csvModal.close(); closeRightMenuOnMobile();
            state.ui.status = { text: "Provide CSV data and rules", type: "info", banner: modalBanner };
            csvAppendBtn.disabled = false; csvReplaceBtn.disabled = false; csvCancelBtn.disabled = false;
        }, 500);
    } catch (err) {
        state.ui.status = { text: `Import failed: ${err.message}`, type: "error", banner: modalBanner };
        csvAppendBtn.disabled = false; csvReplaceBtn.disabled = false; csvCancelBtn.disabled = false;
    }
}

csvAppendBtn.addEventListener("click", () => processCsvImport('append'));
csvReplaceBtn.addEventListener("click", () => processCsvImport('replace'));

// --- Standard Event Handlers ----------------------------------------
renderDataToggle.addEventListener("change", async () => {
    state.ui.dataRendering = renderDataToggle.checked; syncUIState();
    if (state.ui.dataRendering) await renderGuiJournal();
});

viewToggleButton.addEventListener("click", () => {
    state.ui.view = state.ui.view === "journal" ? "report" : "journal"; syncUIState();
});

function openRightMenuOnMobile() { mainContent.classList.add("show-right-pane"); }
function closeRightMenuOnMobile() { mainContent.classList.remove("show-right-pane"); }

if (mobileMenuBtn && mobileCloseBtn) {
    mobileMenuBtn.addEventListener("click", openRightMenuOnMobile);
    mobileCloseBtn.addEventListener("click", closeRightMenuOnMobile);
}

journalText.addEventListener("input", () => {
    commitFileState(state.files.active, journalText.value, true);
    scheduleReparse();
});

forecastToggle.addEventListener("change", reparse);

clearButton.addEventListener("click", () => {
    output.value = ""; guiOutputPanel.innerHTML = "";
    state.ui.status = { text: "Output cleared.", type: "info", banner: statusBanner }; state.ui.view = "report"; syncUIState();
});

// --- Settings Event Handlers ----------------------------------------
settingsBtn.addEventListener("click", () => {
    settingDarkMode.checked = state.ui.darkMode;
    settingsModal.showModal();
});
closeSettingsModal.addEventListener("click", () => settingsModal.close());

settingDarkMode.addEventListener("change", (e) => {
    state.ui.darkMode = e.target.checked;
});

settingFontSize.addEventListener("input", (e) => {
    state.ui.fontSize = e.target.value;
});

settingHideBanner.addEventListener("change", (e) => {
    state.ui.hideBanner = e.target.checked;
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
        row.innerHTML = `<input type="text" class="post-acct" list="account-suggestions" placeholder="${def.placeholder}" required />
                         <input type="text" class="post-amt" placeholder="Amount (optional)" />
                         <button type="button" class="secondary remove-post-btn" style="padding: 0 8px; min-height: 34px; color: #900c0c;">×</button>`;
        attachRemoveRowListener(row.querySelector(".remove-post-btn"));
        postingsContainer.appendChild(row);
    });
    rawToggle.checked = false; visualTxnUi.style.display = "block"; rawTxnContainer.style.display = "none"; rawTxnInput.value = "";
    state.ui.status = { text: "Fill in transaction details", type: "info", banner: modalStatusBanner };
    txnModal.showModal();
});

function attachRemoveRowListener(btn) {
    btn.addEventListener("click", (e) => {
        const row = e.target.closest(".posting-row");
        if (postingsContainer.children.length > 2) row.remove();
        else state.ui.status = { text: "A transaction must have at least 2 postings.", type: "error", banner: modalStatusBanner };
    });
}

addPostingBtn.addEventListener("click", () => {
    const row = document.createElement("div"); row.className = "posting-row";
    row.style.cssText = "display: grid; grid-template-columns: 2fr 1fr auto; gap: 8px; align-items: center;";
    row.innerHTML = `<input type="text" class="post-acct" list="account-suggestions" placeholder="Account (e.g. expenses:food)" required />
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
        if (!rawTxnText) { state.ui.status = { text: "Transaction text cannot be empty.", type: "error", banner: modalStatusBanner }; return; }
    } else {
        const dateVal = txnDate.value, descVal = txnDesc.value.trim();
        if (!dateVal || !descVal) { state.ui.status = { text: "Please fill in Date and Description.", type: "error", banner: modalStatusBanner }; return; }
        const postingRows = postingsContainer.querySelectorAll(".posting-row");
        if (postingRows.length < 2) { state.ui.status = { text: "A transaction requires at least 2 postings.", type: "error", banner: modalStatusBanner }; return; }
        for (const row of postingRows) {
            if (!row.querySelector(".post-acct").value.trim()) { state.ui.status = { text: "All posting rows must have an account specified.", type: "error", banner: modalStatusBanner }; return; }
        }
        rawTxnText = buildTransactionText();
    }

    state.ui.status = { text: editingTxnId !== null ? "Saving changes..." : "Adding transaction...", type: "loading", banner: modalStatusBanner };
    state.ui.reportButtonsEnabled = false;

    try {
        let result = editingTxnId !== null ? await state.hledger.session.updateTransaction(editingTxnId, rawTxnText) : await state.hledger.session.balanceTransaction(rawTxnText);
        if (result && result.error) { state.ui.status = { text: `Error: ${result.error}`, type: "error", banner: modalStatusBanner }; state.ui.reportButtonsEnabled = true; return; }
        await syncAfterTxnMutation(result.rawText);
        state.ui.status = { text: editingTxnId !== null ? "Transaction updated successfully." : "Transaction added successfully.", type: "ok", banner: statusBanner };
        txnModal.close();
    } catch (error) {
        console.error(error); state.ui.status = { text: "Failed to process transaction.", type: "error", banner: modalStatusBanner }; state.ui.reportButtonsEnabled = true;
    }
});

// --- Report Builder Setup --------------------------------------
const reportGroups = [
    { label: "Validate", items: [{ id: "check", label: "Check", run: (q) => checkStrictToggle.checked ? state.hledger.session.checkStrict(q) : state.hledger.session.check(q) }] },
    { label: "Listings", items: [{ id: "accounts", label: "Accounts", run: (q) => state.hledger.session.accounts(q) }, { id: "payees", label: "Payees", run: (q) => state.hledger.session.payees(q) }, { id: "commodities", label: "Commodities", run: (q) => state.hledger.session.commodities(q) }, { id: "tags", label: "Tags", run: (q) => state.hledger.session.tags(q) }] },
    { label: "Reports", items: [{ id: "balance", label: "Balance", run: (q) => state.hledger.session.balance(q) }, { id: "register", label: "Register", run: (q) => state.hledger.session.register(q) }, { id: "print", label: "Print", run: (q) => state.hledger.session.print(q) }, { id: "prices", label: "Prices", run: (q) => state.hledger.session.prices(q) }] },
    { label: "Statements", items: [{ id: "balancesheet", label: "Balance sheet", run: (q) => state.hledger.session.balancesheet(q) }, { id: "incomestatement", label: "Income statement", run: (q) => state.hledger.session.incomestatement(q) }, { id: "cashflow", label: "Cash flow", run: (q) => state.hledger.session.cashflow(q) }, { id: "budget", label: "Budget report", run: (q) => state.hledger.session.budget(q) }] },
    { label: "Export", items: [{ id: "printtext", label: ".journal", run: (q) => state.hledger.session.printText(q) }] },
];


for (const group of reportGroups) {
    const groupEl = document.createElement("div"); groupEl.className = "report-group";
    const labelEl = document.createElement("div"); labelEl.className = "report-group-label"; labelEl.textContent = group.label; groupEl.appendChild(labelEl);
    const buttonsEl = document.createElement("div"); buttonsEl.className = "buttons";
    for (const item of group.items) {
        const btn = document.createElement("button"); btn.id = item.id; btn.textContent = item.label; btn.disabled = true;
        btn.addEventListener("click", () => {
            if (!state.hledger.session.isLoaded || !state.files.active) { state.ui.status = { text: "No valid journal loaded.", type: "error", banner: statusBanner }; return; }
            runReport(item.id, item.label, () => item.run(queryInput.value));
        });
        buttonsEl.appendChild(btn); reportButtons.push(btn);
    }
    groupEl.appendChild(buttonsEl); reportGroupsContainer.appendChild(groupEl);
}

async function runReport(reportId, label, action) {
    state.ui.view = "report"; syncUIState(); state.ui.reportButtonsEnabled = false;
    state.ui.status = { text: `Running ${label}...`, type: "loading", banner: statusBanner };
    try {
        const result = await action();
        output.value = (result && typeof result.data === 'string') ? result.data : JSON.stringify(result, null, 2);
        guiOutputPanel.innerHTML = "";
        const strategy = reportStrategies[reportId] || smartRender;
        guiOutputPanel.appendChild(strategy(result));
        state.ui.status = { text: `${label} report finished.`, type: "ok", banner: statusBanner };
    } catch (error) {
        output.value = error.stack || String(error);
        guiOutputPanel.innerHTML = `<div class="status-banner" data-state="error" style="position: static; margin-top: 20px;"><span class="status-dot"></span><span>Error running ${label}: ${escapeHtml(error.message || String(error))}</span></div>`;
        state.ui.status = { text: `${label} report failed.`, type: "error", banner: statusBanner };
    } finally { state.ui.reportButtonsEnabled = state.hledger.session.isLoaded; }
}


// --- Init -----------------------------------------------------------
state.ui.status = { text: "Initializing WASM module...", type: "loading", banner: statusBanner };
state.hledger.session = await HledgerSession.init();

const files = syncFilesystem();
//updateFileSelector();

const startupModal = document.getElementById("startup-modal");
const startupNewBtn = document.getElementById("startup-new-btn");

//enforceFileLockdown();
syncUIState();

// Check if we have files to show, otherwise go straight to the "New File" modal
if (files.length === 0) {
    state.files.active = null;
    setTimeout(() => newFileModal.showModal(), 500);
    state.ui.status = { text: "Ready", type: "ok", banner: statusBanner };
} else if (files.length === 1) {
    // Automatically open the file if there is only one available
    state.files.active = files[0];

    const content = StorageManager.getLocalFile(state.files.active) || "";
    commitFileState(state.files.active, content, false);
    //enforceFileLockdown();
    await reparse();
    state.ui.status = { text: "Ready", type: "ok", banner: statusBanner };
} else {
    // Show the startup modal if there are multiple files to choose from
    state.files.active = null;
    setTimeout(() => startupModal.showModal(), 500);
    state.ui.status = { text: "Ready", type: "ok", banner: statusBanner };
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


import { initWedgerEditors } from "./codemirror/bundle.js";
initWedgerEditors();