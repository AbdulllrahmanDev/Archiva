const { app, BrowserWindow, ipcMain, Menu, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { loadEncryptedEnv } = require('./env-crypto');
const envPathEnc = path.join(__dirname, '.env.enc');
const envPathPlain = path.join(__dirname, '.env');

if (!loadEncryptedEnv(envPathEnc)) {
    // Fallback to plain .env for development
    if (fs.existsSync(envPathPlain)) {
        require('dotenv').config({ path: envPathPlain });
    }
}


// Live Reload for Development (only in dev mode)
if (!app.isPackaged) {
    require('electron-reload')(__dirname, {
        electron: path.join(__dirname, 'node_modules', '.bin', 'electron'),
        ignored: /.*\.json|.*\.sqlite3|.*\.db|.*[/\\]archive[/\\]/ // Ignore database and sidecar updates
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
    console.log(`Auto-Analysis: ${autoAnalysisEnabled ? 'ENABLED' : 'DISABLED'}, ActivatedAt: ${autoAnalysisActivatedAt || 'N/A'}`);
}

function initStorage() {
    const configPath = path.join(app.getPath('userData'), 'archiva-config.json');
    let savedPath = app.isPackaged 
        ? path.join(app.getPath('documents'), 'Archiva Storage')
        : path.join(__dirname, 'MAIN Archiva');
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
            AI_MODEL: process.env.AI_MODEL || 'google/gemini-2.0-flash-001',
            AUTO_ANALYSIS_ENABLED: autoAnalysisEnabled ? '1' : '0',
            AUTO_ANALYSIS_ACTIVATED_AT: autoAnalysisActivatedAt || '',
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
            
            console.log(`Python: ${trimmed}`); // Debug log all python output

            if (trimmed.startsWith('{')) {
                try {
                    const json = JSON.parse(trimmed);
                    if (json.type === 'status') {
                        mainWindow.webContents.send('status-update', json); // Send the whole object
                    } else if (json.type === 'sync_complete') {
                        console.log(`AI processing complete for doc: ${json.doc_id || 'initial'}. Refreshing UI...`);
                        sendUpdateToRenderer(); // THIS is what stops the spinner
                    } else if (json.type === 'document_added') {
                        console.log("Document added by AI:", json.data?.title);
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
    // Write sentinel files so the watcher starts with correct auto-analysis state
    writeSentinelFiles(autoAnalysisEnabled, autoAnalysisActivatedAt);
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
    console.log(`Processing ${files.length} uploads... (forceAi: ${forceAi})`);
    const dateStr = new Date().toISOString().split('T')[0];

    const tasks = files.map(file => {
        return new Promise((resolve) => {
            const destPath = path.join(watchFolder, file.name);
            try {
                fs.copyFileSync(file.path, destPath);
                
                // Deterministic ID based on filename hash for perfect matching
                const crypto = require('crypto');
                const normalizedName = file.name.normalize('NFC');
                const fileId = crypto.createHash('sha256').update(normalizedName).digest('hex').substring(0, 24);
                const ext = path.extname(file.name).toLowerCase();
                const type = ext === '.pdf' ? 'PDF' : 'IMAGE';
                
                // If forceAi is true, write the sentinel file for this specific fileId
                if (forceAi) {
                    const sentinelDir = path.join(watchFolder, '.archiva');
                    if (!fs.existsSync(sentinelDir)) fs.mkdirSync(sentinelDir);
                    fs.writeFileSync(path.join(sentinelDir, `force_ai_${fileId}.tmp`), '1', 'utf8');
                }

                db.run(`INSERT OR REPLACE INTO documents (id, file, file_path, title, date_added, type, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [fileId, file.name, destPath, file.name.split('.')[0], dateStr, type, 'processing'], 
                    (err) => {
                        if (err) {
                            console.error("Fast Insert Error:", err);
                            resolve({ success: false, error: err });
                        } else {
                            resolve({ success: true });
                        }
                    }
                );
            } catch (err) {
                console.error(`Error copying file: ${err}`);
                resolve({ success: false, error: err });
            }
        });
    });

    const results = await Promise.all(tasks);
    sendUpdateToRenderer(); // Refresh UI
    const allSuccessful = results.every(r => r.success);
    
    console.log(`Upload sequence complete. All successful: ${allSuccessful}`);
    return { success: allSuccessful };
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

    const setClauses = updates.map(([k]) => `${k} = ?`).join(', ');
    const values = [...updates.map(([, v]) => v), id];

    return new Promise((resolve) => {
        db.run(`UPDATE documents SET ${setClauses} WHERE id = ?`, values, (err) => {
            if (err) {
                console.error('Update doc error:', err);
                resolve({ success: false, error: err.message });
            } else {
                sendUpdateToRenderer();
                resolve({ success: true });
            }
        });
    });
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

                // 2. Immediately spawn processor.py on this file with explicit ID
                const { spawn } = require('child_process');
                let executable = 'python';
                if (process.platform === 'win32') {
                    const venvPath = path.join(__dirname, 'venv', 'Scripts', 'python.exe');
                    if (fs.existsSync(venvPath)) executable = venvPath;
                }
                
                const scriptPath = path.join(__dirname, 'backend', 'processor.py');
                // Pass --id to ensure consistency even if renamed
                const pyProcess = spawn(executable, [scriptPath, filePath, watchFolder, '--id', id], {
                    env: {
                        ...process.env,
                        PYTHONIOENCODING: 'utf-8',
                        PYTHONUTF8: '1',
                        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
                        AI_MODEL: process.env.AI_MODEL || 'google/gemini-2.0-flash-001'
                    }
                });

                pyProcess.stdout.on('data', (d) => {
                    const lines = d.toString().split('\n');
                    lines.forEach(line => {
                        const trimmed = line.trim();
                        if (!trimmed) return;
                        if (trimmed.startsWith('{')) {
                            try {
                                const json = JSON.parse(trimmed);
                                if (json.type === 'sync_complete') sendUpdateToRenderer();
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
    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.AI_MODEL || 'google/gemini-2.0-flash-001';

    if (!apiKey) {
        return { error: 'API Key is missing. Please set OPENROUTER_API_KEY in the .env file.' };
    }

    try {
        const processedMessages = await Promise.all(messages.map(async msg => {
            let contentArray = [];
            
            if (msg.content) {
                contentArray.push({ type: 'text', text: msg.content });
            }

            if (msg.attachments && msg.attachments.length > 0) {
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

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://archiva-desktop.app",
                "X-Title": "Archiva Intelligence Engine"
            },
            body: JSON.stringify({
                model: model,
                messages: processedMessages
            })
        });

        const data = await response.json();
        
        if (data.error) {
            return { error: data.error.message || 'API Error' };
        }

        return { text: data.choices[0].message.content };

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
                AI_MODEL: process.env.AI_MODEL || 'google/gemini-2.0-flash-001'
            }
        });

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
    writeSentinelFiles(enabled, config.autoAnalysisActivatedAt);

    console.log(`Auto-Analysis toggled: ${enabled ? 'ENABLED' : 'DISABLED'} at ${autoAnalysisActivatedAt || 'N/A'}`);
    return { success: true, enabled, activatedAt: config.autoAnalysisActivatedAt };
});

/**
 * Write control sentinel files into the watch folder.
 * watcher.py polls these files to know the current auto-analysis state.
 * No backend restart needed — state change takes effect within ~2 seconds.
 */
function writeSentinelFiles(enabled, activatedAt) {
    if (!watchFolder || !fs.existsSync(watchFolder)) return;

    const sentinelDir  = path.join(watchFolder, '.archiva');
    const enabledFile  = path.join(sentinelDir, 'auto_analysis_enabled');
    const tsFile       = path.join(sentinelDir, 'activation_timestamp');

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
        console.log(`Sentinel files updated: enabled=${enabled}, ts=${activatedAt || 'N/A'}`);
    } catch (e) {
        console.error('Error writing sentinel files:', e);
    }
}
