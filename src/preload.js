// preload.js - Secure bridge between main and renderer processes
const { contextBridge, ipcRenderer } = require('electron')

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Employee operations
  getEmployees: () => ipcRenderer.invoke('get-employees'),
  syncEmployees: () => ipcRenderer.invoke('sync-employees'),
  
  // Attendance operations
  clockAttendance: (attendanceData) => ipcRenderer.invoke('clock-attendance', attendanceData),
  getTodayAttendance: () => ipcRenderer.invoke('get-today-attendance'),
  getEmployeeAttendance: (employeeUid, dateRange) => ipcRenderer.invoke('get-employee-attendance', employeeUid, dateRange),
  getTodayStatistics: () => ipcRenderer.invoke('get-today-statistics'),
  
  // Settings operations
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (settings) => ipcRenderer.invoke('update-settings', settings),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  
  // Export operations
  exportAttendanceData: (exportOptions) => ipcRenderer.invoke('export-attendance-data', exportOptions),
  getExportFormats: () => ipcRenderer.invoke('get-export-formats'),
  getExportStatistics: (dateRange) => ipcRenderer.invoke('get-export-statistics', dateRange),
  
  // Attendance sync operations
  syncAttendanceToServer: () => ipcRenderer.invoke('sync-attendance-to-server'),
  getUnsyncedAttendanceCount: () => ipcRenderer.invoke('get-unsynced-attendance-count'),
  getAllAttendanceForSync: () => ipcRenderer.invoke('get-all-attendance-for-sync'),
  markAttendanceAsSynced: (attendanceIds) => ipcRenderer.invoke('mark-attendance-as-synced', attendanceIds),
  
  // Profile operations
  checkProfileImages: () => ipcRenderer.invoke('check-profile-images'),
  
  // Asset path operations
  getAssetPath: (filename) => ipcRenderer.invoke('get-asset-path', filename),
  getProfilePath: (filename) => ipcRenderer.invoke('get-profile-path', filename),
  
  // Event listeners for main process messages
  onShowExportDialog: (callback) => {
    ipcRenderer.on('show-export-dialog', callback)
    // Return a function to remove the listener
    return () => ipcRenderer.removeAllListeners('show-export-dialog')
  },
  
  onSyncAttendanceToServer: (callback) => {
    ipcRenderer.on('sync-attendance-to-server', callback)
    return () => ipcRenderer.removeAllListeners('sync-attendance-to-server')
  },
  
  // Utility functions
  platform: process.platform,
  versions: {
    node: process.versions.node,
    electron: process.versions.electron,
    chrome: process.versions.chrome
  },
  
  // WebSocket client setup (if needed)
  setupWebSocket: (url) => {
    // Return a promise that resolves when WebSocket is connected
    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(url)
        ws.onopen = () => resolve(ws)
        ws.onerror = (error) => reject(error)
      } catch (error) {
        reject(error)
      }
    })
  },
  
  // File system operations (safe subset)
  fileExists: (filePath) => ipcRenderer.invoke('file-exists', filePath),
  readTextFile: (filePath) => ipcRenderer.invoke('read-text-file', filePath),
  writeTextFile: (filePath, content) => ipcRenderer.invoke('write-text-file', filePath, content),
  
  // Development mode detection
  isDev: process.env.NODE_ENV === 'development' || process.argv.includes('--dev')
})

// Optional: Log when preload script is loaded
console.log('Preload script loaded successfully')