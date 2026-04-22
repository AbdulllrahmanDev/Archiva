const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    onDocumentsUpdate: (callback) => {
        ipcRenderer.removeAllListeners('documents-update');
        ipcRenderer.on('documents-update', (event, docs) => callback(docs));
    },
    onStatusUpdate: (callback) => {
        ipcRenderer.removeAllListeners('status-update');
        ipcRenderer.on('status-update', (event, status) => callback(status));
    },
    getDocuments: () => ipcRenderer.invoke('get-documents'),
    selectFiles: () => ipcRenderer.invoke('select-files'),
    processUploads: (files, forceAi) => ipcRenderer.invoke('process-uploads', files, forceAi),
    openPath: (path) => ipcRenderer.invoke('open-path', path),
    showItemInFolder: (path) => ipcRenderer.invoke('show-item-in-folder', path),
    exportFile: (sourcePath, defaultName) => ipcRenderer.invoke('export-file', sourcePath, defaultName),
    sendChat: (messages) => ipcRenderer.invoke('ai-chat', messages),
    deleteDocument: (id, filePath) => ipcRenderer.invoke('delete-document', id, filePath),
    deleteMultipleDocuments: (docs) => ipcRenderer.invoke('delete-multiple-documents', docs),
    clearArchive: () => ipcRenderer.invoke('clear-archive'),
    sendReady: () => ipcRenderer.send('web-ready'),
    // Memory / Import feature
    selectImportFolder: () => ipcRenderer.invoke('select-import-folder'),
    importFolder: (folderPath) => ipcRenderer.invoke('import-folder', folderPath),
    
    // Storage Configuration
    getStorageFolder: () => ipcRenderer.invoke('get-storage-folder'),
    changeStorageFolder: () => ipcRenderer.invoke('change-storage-folder'),

    // Document Editing
    updateDocument: (id, fields) => ipcRenderer.invoke('update-document', id, fields),
    reprocessDocument: (id, filePath) => ipcRenderer.invoke('reprocess-document', id, filePath),
    setNativeTheme: (theme) => ipcRenderer.send('set-native-theme', theme),

    // Auto-Analysis Toggle
    getAutoAnalysisStatus: () => ipcRenderer.invoke('get-auto-analysis-status'),
    toggleAutoAnalysis: (enabled) => ipcRenderer.invoke('toggle-auto-analysis', enabled),

    // PDF Split Toggle
    getPDFSplitStatus: () => ipcRenderer.invoke('get-pdf-split-status'),
    togglePDFSplit: (enabled) => ipcRenderer.invoke('toggle-pdf-split', enabled),
    
    // Smart Project Matching
    getSmartProjectStatus: () => ipcRenderer.invoke('get-smart-project-status'),
    toggleSmartProject: (enabled) => ipcRenderer.invoke('toggle-smart-project', enabled),
    
    // Force Stop
    stopBackend: () => ipcRenderer.invoke('stop-backend')
});
