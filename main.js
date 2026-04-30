const { app, BrowserWindow, ipcMain, Menu, dialog, shell, nativeTheme } = require('electron');
const { autoUpdater } = require('electron-updater');
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
let autoAnalysisEnabled = false;
let autoAnalysisActivatedAt = null;
let pdfSplitEnabled = false;
let smartProjectMatchingEnabled = false;
let activeProcesses = new Set();
let isForceStopped = false;

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

    // By default, Auto-Analysis is disabled to save API credits
    autoAnalysisEnabled = config.autoAnalysisEnabled === true;

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
    pdfSplitEnabled = config.pdfSplitEnabled === true; // Default false to prevent automatic background splitting
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
                                       'subject TEXT', 'project TEXT', 'doc_date TEXT', 'version_no TEXT', 'intel_card TEXT',
                                       'is_manual INTEGER DEFAULT 0', 'governorate TEXT'];
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

function cleanupEmptyDirsSync(startDir, stopDir) {
    try {
        if (!startDir || !stopDir) return;
        let currDir = path.resolve(startDir);
        const baseDir = path.resolve(stopDir);
        
        while (currDir && currDir.length > 3) {
            if (currDir === baseDir) break;
            
            if (fs.existsSync(currDir) && fs.statSync(currDir).isDirectory()) {
                const files = fs.readdirSync(currDir);
                // Filter out hidden files like .DS_Store or empty strings if any
                if (files.length === 0) {
                    fs.rmdirSync(currDir);
                    console.log(`Deleted empty directory: ${currDir}`);
                    currDir = path.dirname(currDir);
                } else {
                    break;
                }
            } else {
                break;
            }
        }
    } catch (e) {
        console.error('Error cleaning up empty directory:', e);
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        backgroundColor: '#ffffff',
        icon: path.join(__dirname, '.icon-ico', 'icon.ico'),
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
            AI_MODEL: process.env.AI_MODEL || 'google/gemini-2.5-flash-lite',
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
    setupAutoUpdater();


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

ipcMain.handle('process-uploads', async (event, files, forceAi, manualSplit) => {
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
                        `INSERT OR REPLACE INTO documents (id, file, file_path, title, date_added, type, status, is_manual) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [fileId, file.name, destPath, file.name.split('.')[0], dateStr, type, 'processing', manualSplit ? 1 : 0],
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

                // Respect the auto-analysis and PDF split toggles
                if (!autoAnalysisEnabled && !forceAi) {
                    args.push('--skip-ai');
                }
                if (manualSplit) {
                    args.push('--split');
                } else {
                    args.push('--no-split');
                }

                const pyProcess = spawn(executable, args, {
                    env: {
                        ...process.env,
                        PYTHONIOENCODING: 'utf-8',
                        PYTHONUTF8: '1',
                        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
                        AI_MODEL: process.env.AI_MODEL || 'google/gemini-2.5-flash-lite',
                        SMART_PROJECT_MATCHING: smartProjectMatchingEnabled ? '1' : '0'
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

ipcMain.handle('get-file-data', async (event, filePath) => {
    try {
        if (!fs.existsSync(filePath)) throw new Error('File not found');
        const data = await fs.promises.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        let mimeType = 'application/octet-stream';
        if (ext === '.pdf') mimeType = 'application/pdf';
        else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
        else if (ext === '.png') mimeType = 'image/png';
        
        return `data:${mimeType};base64,${data.toString('base64')}`;
    } catch (err) {
        console.error('Error reading file for preview:', err);
        return null;
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
    const allowedFields = ['subject', 'project', 'doc_date', 'version_no', 'title', 'summary', 'governorate'];
    const updates = Object.entries(fields).filter(([k]) => allowedFields.includes(k));
    if (updates.length === 0) return { success: false, error: 'No valid fields' };

    return new Promise((resolve) => {
        db.get(`SELECT * FROM documents WHERE id = ?`, [id], async (err, doc) => {
            if (err || !doc) return resolve({ success: false, error: err ? err.message : 'Doc not found' });
            
            // Check if we need to reorganize
            let needsReorganize = false;
            if (fields.subject !== undefined && fields.subject !== doc.subject) needsReorganize = true;
            if (fields.project !== undefined && fields.project !== doc.project) needsReorganize = true;
            if (fields.doc_date !== undefined && fields.doc_date !== doc.doc_date) {
                // Only move the file if the YEAR changes, not just day/month
                const oldYear = (doc.doc_date || '').split('-')[0];
                const newYear = (fields.doc_date || '').split('-')[0];
                if (oldYear !== newYear) needsReorganize = true;
            }
            if (fields.governorate !== undefined && fields.governorate !== doc.governorate) needsReorganize = true;
            
            const updatedDoc = { ...doc, ...fields, is_manual: 1 };
            
            if (needsReorganize) {
                // Call the new centralized move logic
                const result = await organizeFileAndSaveDb(updatedDoc, watchFolder);
                resolve(result);
            } else {
                // Just update DB fields
                const fieldsToUpdate = { ...fields, is_manual: 1 };
                const updatesWithManual = Object.entries(fieldsToUpdate);
                const setClauses = updatesWithManual.map(([k]) => `${k} = ?`).join(', ');
                const values = [...updatesWithManual.map(([, v]) => v), id];
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
                                    // Windows Fix: Temporarily un-hide and remove read-only to prevent EPERM
                                    try { execSync(`attrib -r -h "${sidecarPath}"`); } catch(e) {}
                                    
                                    let sidecarData = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
                                    Object.assign(sidecarData, fields);
                                    fs.writeFileSync(sidecarPath, JSON.stringify(sidecarData, null, 2), 'utf8');
                                    
                                    // Restore hidden attribute
                                    try { execSync(`attrib +h "${sidecarPath}"`); } catch(e) {}
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
    const trulyUnknownProjects = ["", "غير محدد", "غير_محدد", "n/a", "unknown"];
    let project;
    if (trulyUnknownProjects.includes(projectRaw.toLowerCase())) {
        project = "غير_محدد";
    } else if (projectRaw.toLowerCase() === "عام") {
        project = "عام";
    } else {
        project = projectRaw.replace(/[<>:"/\\|?*]/g, "").trim() || "غير_محدد";
    }

    // Determine governorate folder
    let govRaw = (docData.governorate || "").trim();
    const trulyUnknownGov = ["", "غير محدد", "غير_محدد", "غير محددة", "غير_محددة", "n/a", "unknown"];
    let governorate;
    if (trulyUnknownGov.includes(govRaw.toLowerCase())) {
        governorate = "غير_محددة";
    } else {
        governorate = govRaw.replace(/[<>:"/\\|?*]/g, "").trim() || "غير_محددة";
    }
    
    // New hierarchy: Year / Governorate / Project
    const targetDir = path.join(baseFolder, year, governorate, project);
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
        // ── Check if the existing file is the SAME document ────────────────
        // (e.g. from a partial previous move where the file arrived but DB wasn't updated)
        let isSameDoc = false;

        // 1. Check by sidecar ID
        const existingSidecarPath = targetPath.replace(new RegExp(`\\${ext}$`), '.json');
        if (fs.existsSync(existingSidecarPath)) {
            try {
                const existingData = JSON.parse(fs.readFileSync(existingSidecarPath, 'utf8'));
                if (existingData.id && existingData.id === docData.id) {
                    isSameDoc = true;
                    console.log(`[Organize] Target file is same document (sidecar match), reusing: ${targetPath}`);
                }
            } catch(e) {}
        }

        // 2. Fallback: check by SHA256 hash if available
        if (!isSameDoc && docData.sha256) {
            try {
                const crypto = require('crypto');
                const buf = fs.readFileSync(targetPath);
                const hash = crypto.createHash('sha256').update(buf).digest('hex');
                if (hash === docData.sha256) {
                    isSameDoc = true;
                    console.log(`[Organize] Target file is same document (SHA256 match), reusing: ${targetPath}`);
                }
            } catch(e) {}
        }

        if (isSameDoc) {
            // Same document already at target (partial previous move) —
            // delete the stale source file/sidecar and repoint to target.
            if (docData.file_path !== targetPath && fs.existsSync(docData.file_path)) {
                try {
                    fs.unlinkSync(docData.file_path);
                    const oldSc = docData.file_path.replace(new RegExp(`\\${ext}$`), '.json');
                    if (fs.existsSync(oldSc)) fs.unlinkSync(oldSc);
                    cleanupEmptyDirsSync(path.dirname(docData.file_path), watchFolder);
                } catch(e) { console.error('Error cleaning up stale source:', e); }
            }
            docData.file_path = targetPath;
            docData.file = newFilename;
            // File is already in place — skip the rename below
        } else {
            // Different document at target → add suffix to avoid collision
            const uniqueSuffix = Date.now() % 10000;
            newFilename = `${cleanSubject}_${uniqueSuffix}${ext}`;
            targetPath = path.join(targetDir, newFilename);
        }
    }
    
    if (targetPath !== docData.file_path && fs.existsSync(docData.file_path)) {
        try {
            const oldDir = path.dirname(docData.file_path);
            
            // Professional Check: Is the file open/locked? (Simplified check by trying to rename)
            try {
                fs.renameSync(docData.file_path, targetPath);
            } catch (moveErr) {
                let userFriendlyError = "فشل نقل الملف. تأكد أن الملف ليس مفتوحاً في برنامج آخر.";
                if (moveErr.code === 'EBUSY') userFriendlyError = "الملف قيد الاستخدام حالياً، يرجى إغلاقه والمحاولة مرة أخرى.";
                if (moveErr.code === 'EPERM') userFriendlyError = "لا توجد صلاحية لنقل الملف، يرجى التأكد من صلاحيات المجلد.";
                
                console.error("Move Error:", moveErr);
                return { success: false, error: userFriendlyError };
            }

            // Move sidecar if exists
            const oldSidecar = docData.file_path.replace(new RegExp(`\\${ext}$`), '.json');
            const newSidecar = targetPath.replace(new RegExp(`\\${ext}$`), '.json');
            if (fs.existsSync(oldSidecar)) {
                if (process.platform === 'win32') {
                    try { require('child_process').execSync(`attrib -h "${oldSidecar}"`); } catch(e) {}
                }
                try {
                    fs.renameSync(oldSidecar, newSidecar);
                    if (process.platform === 'win32') {
                        try { require('child_process').exec(`attrib +h "${newSidecar}"`, () => {}); } catch(e) {}
                    }
                } catch(scErr) {
                    console.warn("Could not move sidecar:", scErr);
                }
            }
            docData.file_path = targetPath;
            docData.file = newFilename;
            
            // Clean up old directory if empty
            cleanupEmptyDirsSync(oldDir, watchFolder);
        } catch(e) {
            console.error("Fatal move error:", e);
            return { success: false, error: "خطأ غير متوقع أثناء تنظيم الملفات." };
        }
    }

    // Save Sidecar
    const sidecarPath = docData.file_path.replace(new RegExp(`${ext}$`), '.json');
    const sidecarData = { ...docData };
    delete sidecarData.content; // Never store large content in sidecar JSON
    sidecarData.content_preview = docData.content ? docData.content.substring(0, 500) : "";
    
    try {
        // On Windows, writing to a HIDDEN file throws EPERM. Un-hide first if exists.
        if (process.platform === 'win32' && fs.existsSync(sidecarPath)) {
            try { require('child_process').execSync(`attrib -h "${sidecarPath}"`); } catch(e) {}
        }
        
        fs.writeFileSync(sidecarPath, JSON.stringify(sidecarData, null, 2), 'utf8');
        
        if (process.platform === 'win32') {
            try { require('child_process').exec(`attrib +h "${sidecarPath}"`, () => {}); } catch(e) {}
        }
    } catch(e) { 
        console.error("Error saving sidecar:", e); 
    }

    return new Promise((resolve) => {
        // Prepare tags
        const tagsJson = Array.isArray(docData.tags) ? JSON.stringify(docData.tags) : "[]";
        
        db.run(
            `INSERT OR REPLACE INTO documents 
            (id, file, file_path, title, date_added, type, class, area, tags, summary, content, sha256, status, intel_card, subject, project, doc_date, version_no, governorate, is_manual) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [docData.id, docData.file, docData.file_path, docData.title, docData.date_added, docData.type, docData.class, docData.area, tagsJson, docData.summary, docData.content || "", docData.sha256 || "", 'ready', docData.intel_card || "", docData.subject, docData.project, docData.doc_date, docData.version_no, docData.governorate || "", docData.is_manual || 0],
            (err) => {
                if (err) console.error("DB Insert error:", err);
                sendUpdateToRenderer();
                
                // Finish syncing status
                if (mainWindow) {
                    mainWindow.webContents.send('status-update', { type: "status", msg: "sync_complete", doc_id: docData.id });
                    mainWindow.webContents.send('status-update', { type: "status", msg: "status_idle", progress: 0 });
                }
                
                checkBatchProgress(docData.id);
                
                resolve({ 
                    success: !err, 
                    newPath: docData.file_path, 
                    newFile: docData.file 
                });
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

        // 3. Get all 'processing' docs that ARE NOT manual (temporary background files)
        const processingDocs = await new Promise((resolve) => {
            db.all('SELECT id, file_path, file FROM documents WHERE status = ? AND is_manual = 0', ['processing'], (err, rows) => {
                resolve(rows || []);
            });
        });

        // 4. Delete the actual files from watchFolder (only if they are in root and NOT manual)
        for (const doc of processingDocs) {
            const fileInWatch = path.join(watchFolder, doc.file);
            if (fs.existsSync(fileInWatch)) {
                try {
                    fs.unlinkSync(fileInWatch);
                    console.log(`[FORCE STOP] Deleted temporary file: ${fileInWatch}`);
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

        // 5. Delete all 'processing' records from DB, EXCLUDING manual ones
        await new Promise((resolve) => {
            db.run('DELETE FROM documents WHERE status = ? AND is_manual = 0', ['processing'], () => {
                // For manual docs that were 'processing', reset them to 'ready' instead of deleting
                db.run("UPDATE documents SET status = 'ready' WHERE status = 'processing' AND is_manual = 1", () => {
                    sendUpdateToRenderer();
                    resolve();
                });
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
        isForceStopped = false; 
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

                if (!autoAnalysisEnabled) {
                    args.push('--skip-ai');
                }
                
                const pyProcess = spawn(executable, args, {
                    env: {
                        ...process.env,
                        PYTHONIOENCODING: 'utf-8',
                        PYTHONUTF8: '1',
                        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
                        AI_MODEL: process.env.AI_MODEL || 'google/gemini-2.5-flash-lite'
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

ipcMain.handle('stop-processing', async (event, id) => {
    return new Promise((resolve) => {
        db.run('UPDATE documents SET status = ? WHERE id = ?', ['idle', id], (err) => {
            if (err) {
                console.error('Stop processing error:', err);
                resolve({ success: false, error: err.message });
            } else {
                console.log(`[STOP] Manual stop for document ID: ${id}`);
                sendUpdateToRenderer();
                resolve({ success: true });
            }
        });
    });
});

ipcMain.handle('delete-document', async (event, id, filePath) => {
    return new Promise((resolve) => {
        // 1. Delete file from disk if it exists
        if (filePath && fs.existsSync(filePath)) {
            try {
                const dirPath = path.dirname(filePath);
                // Also delete sidecar if exists
                const ext = path.extname(filePath);
                const sidecarPath = filePath.replace(new RegExp(`${ext}$`), '.json');
                if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath);
                
                fs.unlinkSync(filePath);
                cleanupEmptyDirsSync(dirPath, watchFolder);
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
                try { 
                    const dirPath = path.dirname(doc.file_path);
                    const ext = path.extname(doc.file_path);
                    const sidecarPath = doc.file_path.replace(new RegExp(`${ext}$`), '.json');
                    if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath);
                    
                    fs.unlinkSync(doc.file_path);
                    cleanupEmptyDirsSync(dirPath, watchFolder);
                }
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
    const model = process.env.AI_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';

    if (!rawApiKey) {
        return { error: 'API Key is missing. Please set OPENROUTER_API_KEY in the .env file.' };
    }

    const apiKeys = rawApiKey.split(',').map(k => k.trim()).filter(k => k);
    if (apiKeys.length === 0) {
        return { error: 'Invalid API Key format in .env file.' };
    }
    for (let i = apiKeys.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [apiKeys[i], apiKeys[j]] = [apiKeys[j], apiKeys[i]];
    }

    const supportsVision = ['gemini', 'gpt-4o', 'claude-3', 'pixtral', 'llava', 'vision', 'qwen-vl', 'gemma'].some(m => model.toLowerCase().includes(m));

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

    let lastError = null;
    for (let i = 0; i < apiKeys.length; i++) {
        const apiKey = apiKeys[i];
        try {
            console.log(`[AI] Trying key #${i + 1} of ${apiKeys.length}...`);

            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: model,
                    messages: processedMessages,
                    stream: true
                })
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                const errMsg = errData?.error?.message || `HTTP ${response.status}`;
                throw new Error(errMsg);
            }

            // Read SSE stream
            let responseText = "";
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete line
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]') continue;
                    if (trimmed.startsWith('data: ')) {
                        try {
                            const json = JSON.parse(trimmed.slice(6));
                            const content = json.choices?.[0]?.delta?.content;
                            if (content) responseText += content;
                        } catch (_) {}
                    }
                }
            }

            console.log(`[AI] Success with key #${i + 1}`);
            return { text: responseText };

        } catch (err) {
            const msg_lower = err.message?.toLowerCase() || '';
            const isRetryable = msg_lower.includes('rate limit') ||
                                msg_lower.includes('429') ||
                                msg_lower.includes('provider returned error') ||
                                msg_lower.includes('503') ||
                                msg_lower.includes('502') ||
                                msg_lower.includes('no endpoints') ||
                                msg_lower.includes('overloaded');

            console.error(`[AI] Key #${i + 1} failed: ${err.message}`);
            lastError = err;

            if (!isRetryable) {
                console.error('[AI] Non-retryable error, stopping.');
                break;
            }
        }
    }

    console.error('[AI] All keys exhausted.');
    return { error: lastError?.message || 'All API keys failed. Please try again later.' };
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
                AI_MODEL: process.env.AI_MODEL || 'google/gemini-2.5-flash-lite'
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
                enabled: config.autoAnalysisEnabled === true,
                activatedAt: config.autoAnalysisActivatedAt || null
            };
        } catch (e) {
            console.error('Error reading auto-analysis status:', e);
        }
    }
    return { enabled: false, activatedAt: null };
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

function writeSentinelFiles(enabled, activatedAt, splitEnabled, smartMatchEnabled) {
    if (!watchFolder || !fs.existsSync(watchFolder)) return;

    const sentinelDir = path.join(watchFolder, '.archiva');
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
            if (fs.existsSync(tsFile)) fs.unlinkSync(tsFile);
        }

        fs.writeFileSync(splitFile, splitEnabled ? '1' : '0', 'utf8');
        fs.writeFileSync(smartFile, smartMatchEnabled ? '1' : '0', 'utf8');

        console.log("Sentinel files updated successfully.");
    } catch (e) {
        console.error('Error writing sentinel files:', e);
    }
}

// ============================================================
// AUTO-UPDATE SYSTEM
// ============================================================

function setupAutoUpdater() {
    // Check for updates every 1 hour
    setInterval(() => {
        autoUpdater.checkForUpdates();
    }, 60 * 60 * 1000);

    // Immediate check on startup
    autoUpdater.checkForUpdatesAndNotify();

    autoUpdater.on('update-available', (info) => {
        if (mainWindow) mainWindow.webContents.send('update_available', info);
    });

    autoUpdater.on('download-progress', (progressObj) => {
        if (mainWindow) mainWindow.webContents.send('update_progress', progressObj);
    });

    autoUpdater.on('update-not-available', () => {
        console.log('Update not available.');
    });

    autoUpdater.on('update-downloaded', (info) => {
        if (mainWindow) mainWindow.webContents.send('update_downloaded', info);
    });

    autoUpdater.on('error', (err) => {
        console.error('Update Error:', err);
    });
}

ipcMain.on('restart_app', () => {
    autoUpdater.quitAndInstall();
});

ipcMain.handle('check-for-updates-manual', async () => {
    try {
        const result = await autoUpdater.checkForUpdates();
        return { success: true, updateInfo: result.updateInfo };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-app-version', () => app.getVersion());

// Initialize on app start
app.whenReady().then(() => {
    setupAutoUpdater();
});