const { app, BrowserWindow, ipcMain, Menu, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { OpenRouter } = require("@openrouter/sdk");
const { loadEncryptedEnv } = require('./env-crypto.js');

const envPathPlain = path.join(__dirname, '.env');
const envPathEnc = path.join(__dirname, '.env.enc');

// 1. Try plain .env (Development)
if (fs.existsSync(envPathPlain)) {
    require('dotenv').config({ path: envPathPlain });
}

// 2. Try encrypted .env.enc (Production/Bundled)
if (fs.existsSync(envPathEnc)) {
    loadEncryptedEnv(envPathEnc);
}


// Live Reload for Development (only in dev mode)
if (!app.isPackaged) {
    require('electron-reload')(__dirname, {
        electron: path.join(__dirname, 'node_modules', '.bin', 'electron'),
        ignored: [
            /node_modules|[/\\]\./, 
            /.*\.json/, 
            /.*\.sqlite3/, 
            /.*\.db/, 
            /.*[/\\]archive[/\\]/, 
            /.*[/\\]Archiva Data[/\\]/
        ],
        hardResetMethod: 'exit'
    });
}

// Disable the default menu bar
Menu.setApplicationMenu(null);
const sqlite3 = require('sqlite3').verbose();

let mainWindow;
let pythonProcess;
let watchFolder;
let db;
let autoAnalysisEnabled = true;
let autoAnalysisActivatedAt = null;
let pdfSplitEnabled = false;
let smartProjectMatchingEnabled = true;
let activeProcesses = new Set();
let isForceStopped = false; // Blocks any Python output after force stop

function loadAutoAnalysisConfig() {
    const configPath = path.join(app.getPath('userData'), 'archiva-config.json');
    let config = {};
    if (fs.existsSync(configPath)) {
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
            console.error('Error reading auto-analysis config:', e);
        }
    }

    // Default: auto-analysis enabled
    autoAnalysisEnabled = config.autoAnalysisEnabled !== false;

    // If enabled but no activation timestamp yet, set one now (first-time bootstrap)
    if (autoAnalysisEnabled && !config.autoAnalysisActivatedAt) {
        config.autoAnalysisActivatedAt = new Date().toISOString();
        try {
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        } catch(e) {
            console.error('Could not save initial activatedAt timestamp:', e);
        }
    }

    autoAnalysisActivatedAt = config.autoAnalysisActivatedAt || null;
    pdfSplitEnabled = config.pdfSplitEnabled !== false; // Default true
    smartProjectMatchingEnabled = config.smartProjectMatchingEnabled !== false; // Default true
    console.log(`Auto-Analysis: ${autoAnalysisEnabled ? 'ENABLED' : 'DISABLED'}, ActivatedAt: ${autoAnalysisActivatedAt || 'N/A'}`);
    console.log(`PDF Splitting: ${pdfSplitEnabled ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Smart Project Matching: ${smartProjectMatchingEnabled ? 'ENABLED' : 'DISABLED'}`);
}

function initStorage() {
    const configPath = path.join(app.getPath('userData'), 'archiva-config.json');
    let savedPath = app.isPackaged 
        ? path.join(app.getPath('documents'), 'Archiva Storage')
        : path.join(__dirname, 'Archiva Data');
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (config.watchFolder && fs.existsSync(config.watchFolder)) {
                savedPath = config.watchFolder;
            }
        } catch (e) {
            console.error('Error reading config:', e);
        }
    }
    watchFolder = savedPath;

    if (!fs.existsSync(watchFolder)) fs.mkdirSync(watchFolder, { recursive: true });

    if (db) {
        db.close();
    }

    db = new sqlite3.Database(path.join(watchFolder, 'archiva.db'), (err) => {
        if (err) console.error("Database open error:", err);
        else {
            db.serialize(() => {
                // Create table if it doesn't exist
                db.run(`
                    CREATE TABLE IF NOT EXISTS documents (
                        id TEXT PRIMARY KEY,
                        file TEXT,
                        file_path TEXT,
                        title TEXT,
                        date_added TEXT,
                        type TEXT,
                        class TEXT,
                        area TEXT,
                        tags TEXT,
                        summary TEXT,
                        content TEXT,
                        sha256 TEXT,
                        status TEXT DEFAULT 'ready',
                        intel_card TEXT
                    )
                `);
                // Migration: safely add columns that may not exist in older DBs
                const migrationCols = ['file TEXT', 'class TEXT', 'area TEXT', 'tags TEXT',
                                       'summary TEXT', 'content TEXT', 'sha256 TEXT',
                                       'status TEXT DEFAULT \'ready\'',
                                       'subject TEXT', 'project TEXT', 'doc_date TEXT', 'version_no TEXT', 'intel_card TEXT'];
                migrationCols.forEach(colDef => {
                    const colName = colDef.split(' ')[0];
                    db.run(`ALTER TABLE documents ADD COLUMN ${colDef}`, (err) => {
                        if (err && !err.message.includes('duplicate column')) {
                            console.log(`Migration note for '${colName}': ${err.message}`);
                        }
                    });
                });

                // Cleanup stuck processes: Reset 'processing' to 'ready' on startup
                db.run("UPDATE documents SET status = 'ready' WHERE status = 'processing'", (err) => {
                    if (err) console.error("Startup cleanup error:", err);
                    else console.log("Startup: Reset stuck processing documents.");
                });
            });
        }
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        backgroundColor: '#ffffff',
        icon: path.join(__dirname, 'logo', 'Archiva-icon.png'),
        show: true,
        webPreferences: {
            preload: path.join(__dirname, 'src', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        },
    });

    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
    
    // Show window when renderer confirms readiness
    ipcMain.on('set-native-theme', (event, theme) => {
        nativeTheme.themeSource = theme;
    });

    // Primary: show when renderer sends web-ready
    ipcMain.once('web-ready', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
        }
    });

    // Fallback: show window when it's ready to display (in case web-ready never fires)
    mainWindow.once('ready-to-show', () => {
        if (mainWindow && !mainWindow.isVisible()) {
            mainWindow.show();
            mainWindow.focus();
        }
    });

    // Initial data fetch
    mainWindow.webContents.on('did-finish-load', () => {
        sendUpdateToRenderer();
    });
}

function startBackend() {
    let executable;
    let args;

    if (app.isPackaged) {
        // Path to compiled watcher.exe in extraResources
        executable = path.join(process.resourcesPath, 'backend', 'watcher.exe');
        args = [watchFolder];
    } else {
        // Development mode: use venv and python script
        executable = process.platform === 'win32' 
            ? path.join(__dirname, 'venv', 'Scripts', 'python.exe')
            : path.join(__dirname, 'venv', 'bin', 'python');
        args = [path.join(__dirname, 'backend', 'watcher.py'), watchFolder];
    }

    pythonProcess = spawn(executable, args, {
        env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
            OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
            AI_MODEL: process.env.AI_MODEL || 'google/gemini-2.5-flash-preview:free',
            AUTO_ANALYSIS_ENABLED: autoAnalysisEnabled ? '1' : '0',
            AUTO_ANALYSIS_ACTIVATED_AT: autoAnalysisActivatedAt || '',
            PDF_SPLIT_ENABLED: pdfSplitEnabled ? '1' : '0',
            SMART_PROJECT_MATCHING: smartProjectMatchingEnabled ? '1' : '0',
            ARCHIVA_WATCH_FOLDER: watchFolder
        }
    });

    pythonProcess.on('error', (err) => {
        console.error('Failed to start backend process:', err);
    });

    console.log(`Backend launched: ${executable}`);

    console.log(`Node.js Database Path: ${path.join(watchFolder, 'archiva.db')}`);
    
    let pythonBuffer = '';
    pythonProcess.stdout.on('data', (data) => {
        pythonBuffer += data.toString();
        let lines = pythonBuffer.split('\n');
        pythonBuffer = lines.pop(); // Keep last partial line

        lines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return;

            // If force-stopped, silently discard ALL output from Python
            if (isForceStopped) return;

            console.log(`Python: ${trimmed}`); // Debug log all python output

            const jsonMatch = trimmed.match(/\{.*\}/);
            if (jsonMatch) {
                try {
                    const json = JSON.parse(jsonMatch[0]);
                    if (json.type === 'needs_confirmation') {
                        mainWindow.webContents.send('ask-project-similarity', {
                            docData: json.doc_data,
                            similar: json.similar,
                            newProject: json.new_project
                        });
                        return;
                    } else if (json.type === 'status') {
                        mainWindow.webContents.send('status-update', json);
                    } else if (json.type === 'sync_complete') {
                        checkBatchProgress(json.doc_id);
                        sendUpdateToRenderer();
                    } else if (json.type === 'document_added') {
                        sendUpdateToRenderer();
                    } else {
                        sendUpdateToRenderer();
                    }
                } catch (e) {
                    console.error("JSON Parse Error:", e, "Line:", trimmed);
                }
            }
        });
    });

    pythonProcess.stderr.on('data', (data) => {
        console.error(`Python Error: ${data.toString()}`);
    });
}

function sendUpdateToRenderer() {
    db.all('SELECT * FROM documents ORDER BY date_added DESC', [], (err, rows) => {
        if (err) {
            console.error(err);
            return;
        }
        if (mainWindow) {
            mainWindow.webContents.send('documents-update', rows);
        }
    });
}

app.whenReady().then(() => {
    loadAutoAnalysisConfig();
    initStorage();
    // Write sentinel files so the watcher starts with correct state
    writeSentinelFiles(autoAnalysisEnabled, autoAnalysisActivatedAt, pdfSplitEnabled, smartProjectMatchingEnabled);
    createWindow();
    startBackend();


    ipcMain.on('web-ready', () => {
        console.log("Renderer ready signal received.");
        sendUpdateToRenderer();
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

function killBackend() {
    if (pythonProcess && pythonProcess.pid) {
        try {
            if (process.platform === 'win32') {
                require('child_process').execSync(`taskkill /pid ${pythonProcess.pid} /T /F`, { stdio: 'ignore' });
            } else {
                pythonProcess.kill();
            }
        } catch (e) {
            console.error('Failed to kill backend:', e);
        }
        pythonProcess = null;
    }
}

app.on('window-all-closed', () => {
    killBackend();
    if (db) {
        try { db.close(); } catch(e) {}
    }
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    killBackend();
});

// IPC Handlers
let currentBatch = {
    total: 0,
    completedIds: new Set(),
    active: false
};

function checkBatchProgress(docId) {
    if (currentBatch.active && docId) {
        currentBatch.completedIds.add(docId);
        const completed = currentBatch.completedIds.size;
        if (mainWindow) {
            mainWindow.webContents.send('batch-progress', {
                total: currentBatch.total,
                completed: completed,
                active: completed < currentBatch.total
            });
        }
        if (completed >= currentBatch.total) currentBatch.active = false;
    }
}

ipcMain.handle('select-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'Assets', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'webp'] }
        ]
    });

    if (result.canceled) return [];

    return result.filePaths.map(filePath => ({
        name: path.basename(filePath),
        path: filePath,
        size: fs.statSync(filePath).size
    }));
});

ipcMain.handle('process-uploads', async (event, files, forceAi) => {
    console.log(`[IPC] process-uploads: processing ${files.length} files`);
    
    currentBatch.total = files.length;
    currentBatch.completedIds.clear();
    currentBatch.active = true;
    if (mainWindow) {
        mainWindow.webContents.send('batch-progress', {
            total: currentBatch.total,
            completed: 0,
            active: true
        });
    }

    const dateStr = new Date().toISOString().split('T')[0];

    try {
        const tasks = files.map(async (file) => {
            const destPath = path.join(watchFolder, file.name);
            try {
                const crypto = require('crypto');
                const normalizedName = file.name.normalize('NFC');
                const fileId = crypto.createHash('sha256').update(normalizedName).digest('hex').substring(0, 24);
                const ext = path.extname(file.name).toLowerCase();
                const type = ext === '.pdf' ? 'PDF' : 'IMAGE';
                
                // Copy file to watch folder
                await fs.promises.copyFile(file.path, destPath);

                // Insert DB record with 'processing' status
                await new Promise((resolve, reject) => {
                    db.run(
                        `INSERT OR REPLACE INTO documents (id, file, file_path, title, date_added, type, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [fileId, file.name, destPath, file.name.split('.')[0], dateStr, type, 'processing'],
                        (err) => {
                            if (err) {
                                console.error(`[DB] Insert error for ${file.name}:`, err);
                                reject(err);
                            } else {
                                resolve();
                            }
                        }
                    );
                });

                // Directly spawn Python to analyze this file with AI (bypass watcher)
                // This guarantees AI analysis regardless of auto-analysis toggle state
                let executable, args;
                if (app.isPackaged) {
                    executable = path.join(process.resourcesPath, 'backend', 'watcher.exe');
                    args = ['--process-file', destPath, watchFolder, '--id', fileId];
                } else {
                    executable = process.platform === 'win32'
                        ? path.join(__dirname, 'venv', 'Scripts', 'python.exe')
                        : path.join(__dirname, 'venv', 'bin', 'python');
                    args = [path.join(__dirname, 'backend', 'watcher.py'), '--process-file', destPath, watchFolder, '--id', fileId];
                }

                const pyProcess = spawn(executable, args, {
                    env: {
                        ...process.env,
                        PYTHONIOENCODING: 'utf-8',
                        PYTHONUTF8: '1',
                        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
                        AI_MODEL: process.env.AI_MODEL || 'google/gemini-2.5-flash-preview:free',
                        SMART_PROJECT_MATCHING: smartProjectMatchingEnabled ? '1' : '0',
                        PDF_SPLIT_ENABLED: pdfSplitEnabled ? '1' : '0'
                    }
                });

                activeProcesses.add(pyProcess);
                pyProcess.on('exit', () => activeProcesses.delete(pyProcess));

                pyProcess.stdout.on('data', (d) => {
                    const lines = d.toString().split('\n');
                    lines.forEach(line => {
                        const trimmed = line.trim();
                        if (!trimmed) return;
                        console.log(`Python[upload]: ${trimmed}`);
                        if (trimmed.startsWith('{')) {
                            try {
                                const json = JSON.parse(trimmed);
                                if (json.type === 'needs_confirmation') {
                                    mainWindow.webContents.send('ask-project-similarity', {
                                        docData: json.doc_data,
                                        similar: json.similar,
                                        newProject: json.new_project
                                    });
                                } else if (json.type === 'sync_complete') {
                                    checkBatchProgress(json.doc_id);
                                    sendUpdateToRenderer();
                                } else if (json.type === 'status') {
                                    mainWindow.webContents.send('status-update', json);
                                } else {
                                    sendUpdateToRenderer();
                                }
                            } catch(e) {}
                        }
                    });
                });

                pyProcess.stderr.on('data', (d) => {
                    console.error(`Python[upload] Error: ${d.toString()}`);
                });

                return { success: true };
            } catch (err) {
                console.error(`[FS] Error processing ${file.name}:`, err);
                return { success: false, error: err.message };
            }
        });

        const results = await Promise.all(tasks);
        sendUpdateToRenderer(); 
        const allSuccessful = results.every(r => r.success);
        
        console.log(`[IPC] process-uploads complete. Success: ${allSuccessful}`);
        return { success: allSuccessful };
    } catch (err) {
        console.error('[IPC] Fatal error in process-uploads:', err);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('open-path', async (event, pathOrUrl) => {
    if (!pathOrUrl) return;
    try {
        if (pathOrUrl.startsWith('http')) {
            await shell.openExternal(pathOrUrl);
        } else if (fs.existsSync(pathOrUrl)) {
            await shell.openPath(pathOrUrl);
        }
        return { success: true };
    } catch (err) {
        console.error('Open path error:', err);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('show-item-in-folder', async (event, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return { success: false };
    try {
        shell.showItemInFolder(filePath);
        return { success: true };
    } catch (err) {
        console.error('Show in folder error:', err);
        return { success: false };
    }
});

ipcMain.handle('export-file', async (event, sourcePath, defaultName) => {
    const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Document',
        defaultPath: defaultName,
        filters: [
            { name: 'All Files', extensions: ['*'] }
        ]
    });

    if (result.canceled || !result.filePath) return { success: false };

    try {
        fs.copyFileSync(sourcePath, result.filePath);
        return { success: true };
    } catch (err) {
        console.error(`Export error: ${err}`);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('get-documents', async () => {
    return new Promise((resolve, reject) => {
        db.all('SELECT * FROM documents ORDER BY date_added DESC', [], (err, rows) => {
            if (err) reject(err);
            else {
                const enhanced = rows.map(r => {
                    try {
                        if (r.file_path && fs.existsSync(r.file_path)) {
                            const stats = fs.statSync(r.file_path);
                            r.lastAccessed = stats.atimeMs;
                            r.lastModified = stats.mtimeMs;
                        } else {
                            r.lastAccessed = 0;
                            r.lastModified = 0;
                        }
                    } catch(e) {
                        r.lastAccessed = 0;
                        r.lastModified = 0;
                    }
                    return r;
                });
                resolve(enhanced);
            }
        });
    });
});

ipcMain.handle('update-document', async (event, id, fields) => {
    const allowedFields = ['subject', 'project', 'doc_date', 'version_no', 'title', 'summary'];
    const updates = Object.entries(fields).filter(([k]) => allowedFields.includes(k));
    if (updates.length === 0) return { success: false, error: 'No valid fields' };

    return new Promise((resolve) => {
        db.get(`SELECT * FROM documents WHERE id = ?`, [id], async (err, doc) => {
            if (err || !doc) return resolve({ success: false, error: err ? err.message : 'Doc not found' });
            
            // Check if we need to reorganize
            let needsReorganize = false;
            if (fields.subject !== undefined && fields.subject !== doc.subject) needsReorganize = true;
            if (fields.project !== undefined && fields.project !== doc.project) needsReorganize = true;
            if (fields.doc_date !== undefined && fields.doc_date !== doc.doc_date) needsReorganize = true;
            
            const updatedDoc = { ...doc, ...fields };
            
            if (needsReorganize) {
                // Call the new centralized move logic
                const result = await organizeFileAndSaveDb(updatedDoc, watchFolder);
                resolve(result);
            } else {
                // Just update DB fields
                const setClauses = updates.map(([k]) => `${k} = ?`).join(', ');
                const values = [...updates.map(([, v]) => v), id];
                db.run(`UPDATE documents SET ${setClauses} WHERE id = ?`, values, (err) => {
                    if (err) {
                        console.error('Update doc error:', err);
                        resolve({ success: false, error: err.message });
                    } else {
                        // Update JSON inside sidecar
                        try {
                            const ext = path.extname(doc.file);
                            const sidecarPath = doc.file_path.replace(new RegExp(`${ext}$`), '.json');
                            if (fs.existsSync(sidecarPath)) {
                                let sidecarData = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
                                Object.assign(sidecarData, fields);
                                fs.writeFileSync(sidecarPath, JSON.stringify(sidecarData, null, 2), 'utf8');
                            }
                        } catch(e) { console.error("Error updating sidecar:", e); }
                        sendUpdateToRenderer();
                        resolve({ success: true });
                    }
                });
            }
        });
    });
});

ipcMain.handle('confirm-project-similarity', async (event, docData, finalProject) => {
    // Modify docData to use the final project
    docData.project = finalProject;
    return await organizeFileAndSaveDb(docData, watchFolder);
});

// Centralized logic for moving files and saving to DB/Sidecar
async function organizeFileAndSaveDb(docData, baseFolder) {
    const dateStr = docData.doc_date || docData.date_added || "";
    const year = (dateStr.includes('-') && dateStr.length >= 4) ? dateStr.split('-')[0] : new Date().getFullYear().toString();
    
    let projectRaw = (docData.project || "").trim();
    const unknownProjects = ["", "عام", "غير محدد", "غير_محدد", "n/a", "unknown"];
    let project = unknownProjects.includes(projectRaw.toLowerCase()) ? "غير_محدد" : projectRaw.replace(/[<>:"/\\|?*]/g, "").trim() || "غير_محدد";
    
    const targetDir = path.join(baseFolder, year, project);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }
    
    let subjectRaw = (docData.subject || "").trim();
    const unknownSubjects = ["", "غير محدد", "غير_محدد", "وثيقة_غير_معروفة", "n/a", "unknown"];
    let cleanSubject = unknownSubjects.includes(subjectRaw.toLowerCase()) ? (path.parse(docData.file).name) : subjectRaw.replace(/[<>:"/\\|?*]/g, "").trim() || "وثيقة_غير_معروفة";
    
    const ext = path.extname(docData.file) || '.pdf';
    let newFilename = `${cleanSubject}${ext}`;
    let targetPath = path.join(targetDir, newFilename);
    
    if (targetPath !== docData.file_path && fs.existsSync(targetPath)) {
        const uniqueSuffix = Date.now() % 10000;
        newFilename = `${cleanSubject}_${uniqueSuffix}${ext}`;
        targetPath = path.join(targetDir, newFilename);
    }
    
    if (targetPath !== docData.file_path && fs.existsSync(docData.file_path)) {
        try {
            fs.renameSync(docData.file_path, targetPath);
            // Move sidecar if exists
            const oldSidecar = docData.file_path.replace(new RegExp(`${ext}$`), '.json');
            const newSidecar = targetPath.replace(new RegExp(`${ext}$`), '.json');
            if (fs.existsSync(oldSidecar)) {
                fs.renameSync(oldSidecar, newSidecar);
            }
            docData.file_path = targetPath;
            docData.file = newFilename;
        } catch(e) {
            console.error("Error moving file:", e);
        }
    }

    // Save Sidecar
    const sidecarPath = docData.file_path.replace(new RegExp(`${ext}$`), '.json');
    const sidecarData = { ...docData };
    delete sidecarData.content; // Never store large content in sidecar JSON
    sidecarData.content_preview = docData.content ? docData.content.substring(0, 500) : "";
    try {
        fs.writeFileSync(sidecarPath, JSON.stringify(sidecarData, null, 2), 'utf8');
        if (process.platform === 'win32') {
            require('child_process').exec(`attrib +h "${sidecarPath}"`, () => {});
        }
    } catch(e) { console.error("Error saving sidecar:", e); }

    return new Promise((resolve) => {
        // Prepare tags
        const tagsJson = Array.isArray(docData.tags) ? JSON.stringify(docData.tags) : "[]";
        
        db.run(
            `INSERT OR REPLACE INTO documents 
            (id, file, file_path, title, date_added, type, class, area, tags, summary, content, sha256, status, intel_card, subject, project, doc_date, version_no) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [docData.id, docData.file, docData.file_path, docData.title, docData.date_added, docData.type, docData.class, docData.area, tagsJson, docData.summary, docData.content || "", docData.sha256 || "", 'ready', docData.intel_card || "", docData.subject, docData.project, docData.doc_date, docData.version_no],
            (err) => {
                if (err) console.error("DB Insert error:", err);
                sendUpdateToRenderer();
                
                // Finish syncing status
                if (mainWindow) {
                    mainWindow.webContents.send('status-update', { type: "sync_complete", doc_id: docData.id });
                    mainWindow.webContents.send('status-update', { type: "status_idle", progress: 0 });
                }
                
                checkBatchProgress(docData.id);
                
                resolve({ success: !err });
            }
        );
    });
}

ipcMain.handle('stop-backend', async () => {
    console.log('[FORCE STOP] Terminating all active processes...');
    
    // STEP 0: Raise the flag IMMEDIATELY — blocks all Python stdout from reaching UI
    isForceStopped = true;

    try {
        // 1. Kill the main watcher process
        if (pythonProcess && pythonProcess.pid) {
            try {
                if (process.platform === 'win32') {
                    require('child_process').execSync(`taskkill /pid ${pythonProcess.pid} /T /F`, { stdio: 'ignore' });
                } else {
                    pythonProcess.kill();
                }
            } catch (e) {
                console.error('Failed to kill watcher process:', e);
            }
            pythonProcess = null;
        }

        // 2. Kill all manual analysis processes
        for (const proc of activeProcesses) {
            try {
                if (process.platform === 'win32' && proc.pid) {
                    require('child_process').execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
                } else {
                    proc.kill();
                }
            } catch(e) {}
        }
        activeProcesses.clear();

        // 3. Get all 'processing' docs BEFORE deleting from DB
        const processingDocs = await new Promise((resolve) => {
            db.all('SELECT id, file_path, file FROM documents WHERE status = ?', ['processing'], (err, rows) => {
                resolve(rows || []);
            });
        });

        // 4. Delete the actual files from watchFolder (they haven't been organized yet)
        for (const doc of processingDocs) {
            const fileInWatch = path.join(watchFolder, doc.file);
            if (fs.existsSync(fileInWatch)) {
                try {
                    fs.unlinkSync(fileInWatch);
                    console.log(`[FORCE STOP] Deleted pending file: ${fileInWatch}`);
                } catch(e) {
                    console.error(`[FORCE STOP] Could not delete ${fileInWatch}:`, e);
                }
            }
            // Also delete any orphan JSON sidecar next to it
            const sidecarInWatch = fileInWatch.replace(/\.[^/.]+$/, '.json');
            if (fs.existsSync(sidecarInWatch)) {
                try { fs.unlinkSync(sidecarInWatch); } catch(e) {}
            }
        }

        // 5. Delete all 'processing' records from DB
        await new Promise((resolve) => {
            db.run('DELETE FROM documents WHERE status = ?', ['processing'], () => {
                sendUpdateToRenderer();
                resolve();
            });
        });

        // 6. Reset batch state
        currentBatch.active = false;
        currentBatch.completedIds.clear();
        currentBatch.total = 0;

        // 7. Reset the flag BEFORE restarting so the new watcher can communicate normally
        isForceStopped = false;

        // 8. Restart the watcher (clean slate)
        startBackend();

        return { success: true };
    } catch (err) {
        isForceStopped = false; // Always reset on error too
        console.error('Force stop error:', err);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('reprocess-document', async (event, id, filePath) => {
    return new Promise((resolve) => {
        // 1. Reset the status in DB to trigger UI spinner
        db.run('UPDATE documents SET status = ? WHERE id = ?', ['processing', id], (err) => {
            if (err) {
                console.error('Reprocess doc error:', err);
                resolve({ success: false, error: err.message });
            } else {
                sendUpdateToRenderer();
                resolve({ success: true });

                // 2. Immediately spawn the backend on this file with explicit ID
                const { spawn } = require('child_process');
                let executable;
                let args;

                if (app.isPackaged) {
                    // Use bundled watcher.exe in production
                    executable = path.join(process.resourcesPath, 'backend', 'watcher.exe');
                    args = ['--process-file', filePath, watchFolder, '--id', id];
                } else {
                    // Use venv and watcher.py in development
                    executable = process.platform === 'win32' 
                        ? path.join(__dirname, 'venv', 'Scripts', 'python.exe')
                        : path.join(__dirname, 'venv', 'bin', 'python');
                    args = [path.join(__dirname, 'backend', 'watcher.py'), '--process-file', filePath, watchFolder, '--id', id];
                }
                
                const pyProcess = spawn(executable, args, {
                    env: {
                        ...process.env,
                        PYTHONIOENCODING: 'utf-8',
                        PYTHONUTF8: '1',
                        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
                        AI_MODEL: process.env.AI_MODEL || 'google/gemini-2.5-flash-preview:free'
                    }
                });
                
                activeProcesses.add(pyProcess);
                pyProcess.on('exit', () => activeProcesses.delete(pyProcess));

                pyProcess.stdout.on('data', (d) => {
                    const lines = d.toString().split('\n');
                    lines.forEach(line => {
                        const trimmed = line.trim();
                        if (!trimmed) return;
                        if (trimmed.startsWith('{')) {
                            try {
                                const json = JSON.parse(trimmed);
                                if (json.type === 'needs_confirmation') {
                                    mainWindow.webContents.send('ask-project-similarity', {
                                        docData: json.doc_data,
                                        similar: json.similar,
                                        newProject: json.new_project
                                    });
                                    return;
                                } else if (json.type === 'sync_complete') {
                                    checkBatchProgress(json.doc_id);
                                    sendUpdateToRenderer();
                                }
                                else if (json.type === 'document_added') sendUpdateToRenderer();
                                else mainWindow.webContents.send('status-update', json);
                            } catch(e) {}
                        }
                    });
                });
            }
        });
    });
});

ipcMain.handle('delete-document', async (event, id, filePath) => {
    return new Promise((resolve) => {
        // 1. Delete file from disk if it exists
        if (filePath && fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch (err) {
                console.error(`Error deleting file: ${err}`);
            }
        }

        // 2. Delete record from DB
        db.run('DELETE FROM documents WHERE id = ?', [id], (err) => {
            if (err) {
                console.error(`DB Delete Error: ${err}`);
                resolve({ success: false, error: err.message });
            } else {
                resolve({ success: true });
                sendUpdateToRenderer();
            }
        });
    });
});

ipcMain.handle('clear-archive', async () => {
    return new Promise((resolve) => {
        // 1. Delete all files in watch folder
        if (fs.existsSync(watchFolder)) {
            fs.readdirSync(watchFolder).forEach(file => {
                try {
                    fs.unlinkSync(path.join(watchFolder, file));
                } catch (err) {
                    console.error(`Could not delete file ${file}: ${err}`);
                }
            });
        }

        // 2. Clear DB table
        db.run('DELETE FROM documents', [], (err) => {
            if (err) {
                console.error(`DB Clear Error: ${err}`);
                resolve({ success: false, error: err.message });
            } else {
                resolve({ success: true });
                sendUpdateToRenderer();
            }
        });
    });
});

ipcMain.handle('delete-multiple-documents', async (event, docs) => {
    return new Promise((resolve) => {
        let errors = [];
        docs.forEach(doc => {
            if (doc.file_path && fs.existsSync(doc.file_path)) {
                try { fs.unlinkSync(doc.file_path); }
                catch (err) { errors.push(err.message); }
            }
        });

        const ids = docs.map(d => d.id);
        if (ids.length === 0) return resolve({ success: true });
        const placeholders = ids.map(() => '?').join(',');
        
        db.run(`DELETE FROM documents WHERE id IN (${placeholders})`, ids, (err) => {
            if (err) {
                console.error(`DB Batch Delete Error: ${err}`);
                resolve({ success: false, error: err.message });
            } else {
                resolve({ success: true, errors: errors.length > 0 ? errors : null });
                sendUpdateToRenderer();
            }
        });
    });
});

const pdfParse = require('pdf-parse');

ipcMain.handle('ai-chat', async (event, messages) => {
    const rawApiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.AI_MODEL || 'google/gemini-2.5-flash-preview:free';

    if (!rawApiKey) {
        return { error: 'API Key is missing. Please set OPENROUTER_API_KEY in the .env file.' };
    }

    // Load Balancing: Pick a random API key if multiple are provided
    const apiKeys = rawApiKey.split(',').map(k => k.trim()).filter(k => k);
    const apiKey = apiKeys[Math.floor(Math.random() * apiKeys.length)];

    if (!apiKey) {
         return { error: 'Invalid API Key format in .env file.' };
    }

    try {
        const supportsVision = ['gemini', 'gpt-4o', 'claude-3', 'pixtral', 'llava', 'vision', 'qwen-vl'].some(m => model.toLowerCase().includes(m));

        const processedMessages = await Promise.all(messages.map(async msg => {
            let contentArray = [];
            
            if (msg.content) {
                contentArray.push({ type: 'text', text: msg.content });
            }

            if (supportsVision && msg.attachments && msg.attachments.length > 0) {
                for (const attachment of msg.attachments) {
                    const ext = path.extname(attachment.path).toLowerCase();
                    try {
                        let mimeType = 'image/jpeg';
                        if (ext === '.png') mimeType = 'image/png';
                        if (ext === '.webp') mimeType = 'image/webp';
                        if (ext === '.pdf') mimeType = 'application/pdf';
                        
                        const fileData = fs.readFileSync(attachment.path);
                        const base64File = fileData.toString('base64');
                        const dataUrl = `data:${mimeType};base64,${base64File}`;
                        
                        contentArray.push({ type: 'image_url', image_url: { url: dataUrl } });
                    } catch (e) {
                        console.error("Failed to load file:", e);
                    }
                }
            }

            if (contentArray.length === 0) {
                contentArray = msg.content || "";
            } else if (contentArray.length === 1 && contentArray[0].type === 'text') {
                contentArray = contentArray[0].text;
            }

            return { role: msg.role, content: contentArray };
        }));

        const openrouter = new OpenRouter({ apiKey: apiKey });
        
        const stream = await openrouter.chat.send({
            chatRequest: {
                model: model,
                messages: processedMessages,
                stream: true
            }
        });

        let responseText = "";
        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content;
            if (content) {
                responseText += content;
            }
            // Usage information comes in the final chunk
            if (chunk.usage) {
                console.log("\nReasoning tokens:", chunk.usage.reasoningTokens);
            }
        }

        return { text: responseText };

    } catch (err) {
        console.error(err);
        return { error: err.message };
    }
});


// ============================================================
// STORAGE CONFIGURATION & FOLDER SELECTION
// ============================================================

ipcMain.handle('get-storage-folder', () => {
    return watchFolder;
});

ipcMain.handle('change-storage-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select Main Storage Folder'
    });

    if (result.canceled || !result.filePaths.length) return { success: false };

    const newFolder = result.filePaths[0];
    const configPath = path.join(app.getPath('userData'), 'archiva-config.json');
    
    try {
        fs.writeFileSync(configPath, JSON.stringify({ watchFolder: newFolder }));
        
        if (pythonProcess) {
            pythonProcess.kill();
            pythonProcess = null;
        }

        initStorage();
        startBackend();
        sendUpdateToRenderer();

        return { success: true, folder: newFolder };
    } catch (err) {
        console.error('Error changing storage folder:', err);
        return { success: false, error: err.message };
    }
});

// ============================================================
// IMPORT EXTERNAL FOLDER (Memory Feature)
// ============================================================

ipcMain.handle('select-import-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select Archive Folder to Import'
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
});

ipcMain.handle('import-folder', async (event, folderPath) => {
    if (!folderPath || !fs.existsSync(folderPath)) {
        return { success: false, error: 'Folder not found' };
    }

    const venvPython = process.platform === 'win32'
        ? path.join(__dirname, 'venv', 'Scripts', 'python.exe')
        : path.join(__dirname, 'venv', 'bin', 'python');

    const watcherScript = path.join(__dirname, 'backend', 'watcher.py');

    return new Promise((resolve) => {
        const importProc = spawn(venvPython, [watcherScript, '--import', folderPath, watchFolder], {
            env: {
                ...process.env,
                PYTHONIOENCODING: 'utf-8',
                PYTHONUTF8: '1',
                OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
                AI_MODEL: process.env.AI_MODEL || 'google/gemini-2.5-flash-preview:free'
            }
        });

        activeProcesses.add(importProc);
        importProc.on('exit', () => activeProcesses.delete(importProc));

        let buffer = '';
        importProc.stdout.on('data', (data) => {
            buffer += data.toString();
            let lines = buffer.split('\n');
            buffer = lines.pop();
            lines.forEach(line => {
                const trimmed = line.trim();
                if (!trimmed) return;
                console.log(`Import: ${trimmed}`);
                if (trimmed.startsWith('{')) {
                    try {
                        const json = JSON.parse(trimmed);
                        if (json.type === 'status') {
                            mainWindow.webContents.send('status-update', json);
                        } else if (json.type === 'sync_complete') {
                            sendUpdateToRenderer();
                        }
                    } catch (e) {}
                }
            });
        });

        importProc.stderr.on('data', (data) => {
            console.error(`Import Error: ${data.toString()}`);
        });

        importProc.on('close', (code) => {
            console.log(`Import process exited with code ${code}`);
            sendUpdateToRenderer();
            resolve({ success: code === 0 });
        });
    });
});

// ============================================================
// AUTO-ANALYSIS TOGGLE
// ============================================================

ipcMain.handle('get-auto-analysis-status', async () => {
    const configPath = path.join(app.getPath('userData'), 'archiva-config.json');
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            return {
                enabled: config.autoAnalysisEnabled !== false,
                activatedAt: config.autoAnalysisActivatedAt || null
            };
        } catch (e) {
            console.error('Error reading auto-analysis status:', e);
        }
    }
    return { enabled: true, activatedAt: null };
});

ipcMain.handle('toggle-auto-analysis', async (event, enabled) => {
    const configPath = path.join(app.getPath('userData'), 'archiva-config.json');
    let config = {};
    if (fs.existsSync(configPath)) {
        try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) {}
    }

    config.autoAnalysisEnabled = enabled;
    if (enabled) {
        config.autoAnalysisActivatedAt = new Date().toISOString();
    } else {
        config.autoAnalysisActivatedAt = null;
    }

    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('Error saving auto-analysis config:', e);
        return { success: false, error: e.message };
    }

    // Update in-memory state
    autoAnalysisEnabled = enabled;
    autoAnalysisActivatedAt = config.autoAnalysisActivatedAt;

    // Write sentinel files so watcher.py picks up the change WITHOUT a restart
    writeSentinelFiles(enabled, config.autoAnalysisActivatedAt, pdfSplitEnabled);
    console.log(`Auto-Analysis toggled: ${enabled ? 'ENABLED' : 'DISABLED'} at ${autoAnalysisActivatedAt || 'N/A'}`);
    return { success: true, enabled, activatedAt: config.autoAnalysisActivatedAt };
});

ipcMain.handle('get-pdf-split-status', async () => {
    return { enabled: pdfSplitEnabled };
});

ipcMain.handle('toggle-pdf-split', async (event, enabled) => {
    const configPath = path.join(app.getPath('userData'), 'archiva-config.json');
    let config = {};
    if (fs.existsSync(configPath)) {
        try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) {}
    }

    config.pdfSplitEnabled = enabled;
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('Error saving PDF split config:', e);
        return { success: false, error: e.message };
    }

    pdfSplitEnabled = enabled;
    writeSentinelFiles(autoAnalysisEnabled, autoAnalysisActivatedAt, enabled);

    console.log(`PDF Splitting toggled: ${enabled ? 'ENABLED' : 'DISABLED'}`);
    return { success: true, enabled };
});

ipcMain.handle('get-smart-project-status', async () => {
    return { enabled: smartProjectMatchingEnabled };
});

ipcMain.handle('toggle-smart-project', async (event, enabled) => {
    const configPath = path.join(app.getPath('userData'), 'archiva-config.json');
    let config = {};
    if (fs.existsSync(configPath)) {
        try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) {}
    }

    config.smartProjectMatchingEnabled = enabled;
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('Error saving Smart Project config:', e);
        return { success: false, error: e.message };
    }

    smartProjectMatchingEnabled = enabled;
    writeSentinelFiles(autoAnalysisEnabled, autoAnalysisActivatedAt, pdfSplitEnabled, enabled);

    console.log(`Smart Project Matching toggled: ${enabled ? 'ENABLED' : 'DISABLED'}`);
    return { success: true, enabled };
});


/**
 * Write control sentinel files into the watch folder.
 * watcher.py polls these files to know the current auto-analysis state.
 * No backend restart needed — state change takes effect within ~2 seconds.
 */
function writeSentinelFiles(enabled, activatedAt, splitEnabled, smartMatchEnabled) {
    if (!watchFolder || !fs.existsSync(watchFolder)) return;

    const sentinelDir  = path.join(watchFolder, '.archiva');
    const enabledFile  = path.join(sentinelDir, 'auto_analysis_enabled');
    const tsFile       = path.join(sentinelDir, 'activation_timestamp');
    const splitFile    = path.join(sentinelDir, 'pdf_split_enabled');
    const smartFile    = path.join(sentinelDir, 'smart_project_matching');

    try {
        if (!fs.existsSync(sentinelDir)) fs.mkdirSync(sentinelDir);

        if (enabled) {
            fs.writeFileSync(enabledFile, '1', 'utf8');
            fs.writeFileSync(tsFile, activatedAt || '', 'utf8');
        } else {
            fs.writeFileSync(enabledFile, '0', 'utf8');
            // Keep the timestamp file gone so next enable gets fresh ts
            if (fs.existsSync(tsFile)) fs.unlinkSync(tsFile);
        }

        // PDF Split sentinel
        fs.writeFileSync(splitFile, splitEnabled ? '1' : '0', 'utf8');

        // Smart Project Matching sentinel
        fs.writeFileSync(smartFile, smartMatchEnabled ? '1' : '0', 'utf8');

        console.log(`Sentinel files updated: auto=${enabled}, ts=${activatedAt || 'N/A'}, split=${splitEnabled}, smart=${smartMatchEnabled}`);
    } catch (e) {
        console.error('Error writing sentinel files:', e);
    }
}