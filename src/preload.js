// preload.js - Secure bridge between main and renderer processes
const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("electronAPI", {

  // Employee operations
  getEmployees: () => ipcRenderer.invoke("get-employees"),
  syncEmployees: () => ipcRenderer.invoke("sync-employees"),

  // Attendance operations
  clockAttendance: (attendanceData) => ipcRenderer.invoke("clock-attendance", attendanceData),
  getTodayAttendance: () => ipcRenderer.invoke("get-today-attendance"),
  getEmployeeAttendance: (employeeUid, dateRange) =>
    ipcRenderer.invoke("get-employee-attendance", employeeUid, dateRange),
  getTodayStatistics: () => ipcRenderer.invoke("get-today-statistics"),
  getDailySummary: (startDate, endDate) => ipcRenderer.invoke("get-daily-summary", startDate, endDate),

  // Settings operations
  getSettings: () => ipcRenderer.invoke("get-settings"),
  updateSettings: (settings) => ipcRenderer.invoke("update-settings", settings),
  openSettings: () => ipcRenderer.invoke("open-settings"),

  // Export operations
  exportAttendanceData: (exportOptions) => ipcRenderer.invoke("export-attendance-data", exportOptions),
  getExportFormats: () => ipcRenderer.invoke("get-export-formats"),
  getExportStatistics: (dateRange) => ipcRenderer.invoke("get-export-statistics", dateRange),

  // Attendance sync operations
  syncAttendanceToServer: () => ipcRenderer.invoke("sync-attendance-to-server"),
  getUnsyncedAttendanceCount: () => ipcRenderer.invoke("get-unsynced-attendance-count"),
  getAllAttendanceForSync: () => ipcRenderer.invoke("get-all-attendance-for-sync"),
  markAttendanceAsSynced: (attendanceIds) => ipcRenderer.invoke("mark-attendance-as-synced", attendanceIds),

  // Summary sync operations
  getAllDailySummaryForSync: () => ipcRenderer.invoke("get-All-daily-summary-for-sync"),
  syncDailySummaryToServer: () => ipcRenderer.invoke("sync-daily-summary-to-server"),
  getUnsyncedDailySummaryCount: () => ipcRenderer.invoke("get-unsynced-daily-summary-count"),
  forceSyncAllDailySummary: () => ipcRenderer.invoke("force-sync-all-daily-summary"),
  getDailySummaryLastSyncTime: () => ipcRenderer.invoke("get-daily-summary-last-sync-time"),

  // Additional summary sync operations for enhanced functionality
  markSummaryDataChanged: () => ipcRenderer.invoke("mark-summary-data-changed"),
  getSummaryDataChangeStatus: () => ipcRenderer.invoke("get-summary-data-change-status"),
  resetSummaryDataChangeStatus: () => ipcRenderer.invoke("reset-summary-data-change-status"),

  // Profile operations
  checkProfileImages: (employeeUids) => ipcRenderer.invoke("check-profile-images", employeeUids),
  checkAllProfileImages: () => ipcRenderer.invoke("check-all-profile-images"),

  // Bulk download operations
  bulkDownloadProfiles: (serverUrl, options) => ipcRenderer.invoke("bulk-download-profiles", serverUrl, options),
  bulkDownloadByDepartment: (serverUrl, department, onProgress) =>
    ipcRenderer.invoke("bulk-download-by-department", serverUrl, department, onProgress),
  bulkDownloadBySearch: (serverUrl, searchQuery, onProgress) =>
    ipcRenderer.invoke("bulk-download-by-search", serverUrl, searchQuery, onProgress),
  bulkDownloadSpecificEmployees: (serverUrl, employeeUids, onProgress) =>
    ipcRenderer.invoke("bulk-download-specific-employees", serverUrl, employeeUids, onProgress),

  // Profile management operations
  cleanupProfiles: () => ipcRenderer.invoke("cleanup-profiles"),
  getProfilesDirectoryInfo: () => ipcRenderer.invoke("get-profiles-directory-info"),
  getLocalProfilePath: (uid) => ipcRenderer.invoke("get-local-profile-path", uid),
  profileExists: (uid) => ipcRenderer.invoke("profile-exists", uid),

  getProfileImagePath: (uid) => ipcRenderer.invoke("get-profile-image-path", uid),
  getProfileImageData: (uid) => ipcRenderer.invoke("get-profile-image-data", uid),

  // Legacy individual download (kept for backward compatibility)
  downloadAndStoreProfile: (uid, serverUrl) => ipcRenderer.invoke("download-and-store-profile", uid, serverUrl),

  // Validate time operations
  validateAttendanceData: (options) => ipcRenderer.invoke("validate-attendance-data", options),
  validateTodayAttendance: () => ipcRenderer.invoke("validate-today-attendance"),
  validateEmployeeTodayAttendance: () => ipcRenderer.invoke("validate-employee-today-attendance"),
  validateAndCorrectUnsyncedRecords: () => ipcRenderer.invoke("validate-and-correct-unsynced-records"),
  validateSingleRecord: () => ipcRenderer.invoke("validate-single-record"),

invoke: (channel, ...args) => {
  const validChannels = [
    'get-profile-fast',
    'get-profiles-path',
    'save-face-descriptor',
    'read-face-descriptor',
    'delete-face-descriptor',
    'clear-all-face-descriptors',
    'generate-face-descriptor-from-image',
    'generate-descriptor-for-employee',
    'initialize-server-edit-sync',
    'check-server-edits',
    'get-server-edit-sync-history',
    'get-server-edit-last-sync',
    'start-server-edit-auto-sync',
    'stop-server-edit-auto-sync'
  ];
  if (validChannels.includes(channel)) {
    return ipcRenderer.invoke(channel, ...args);
  }
},


// Listener for server edit updates
  onServerEditsApplied: (callback) => {
    ipcRenderer.on('server-edits-applied', (event, data) => callback(data));
  },
  
  // Remove listener
  removeServerEditsListener: () => {
    ipcRenderer.removeAllListeners('server-edits-applied');
  },

  // Cache operations (PRESERVED - these are important for fast data access)
  getCacheStats: () => ipcRenderer.invoke('get-cache-stats'),
  clearProfileCache: () => ipcRenderer.invoke('clear-profile-cache'),
  preloadScanningSession: (barcodes) => ipcRenderer.invoke('preload-scanning-session', barcodes),
  getProfileFast: (barcode) => ipcRenderer.invoke('get-profile-fast', barcode),

  // General invoke method for flexibility
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),

  // Asset path operations
  getAssetPath: (filename) => ipcRenderer.invoke("get-asset-path", filename),
  getProfilePath: (filename) => ipcRenderer.invoke("get-profile-path", filename),

  // Auto-updater operations
  updater: {
    // Check for updates manually
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),

    // Download available update
    downloadUpdate: () => ipcRenderer.invoke('download-update'),

    // Quit and install update
    quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),

    // Get current app version
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),

    // Listen to updater status changes
    onStatusUpdate: (callback) => {
      const subscription = (event, data) => callback(data)
      ipcRenderer.on('updater-status', subscription)

      // Return unsubscribe function
      return () => ipcRenderer.removeListener('updater-status', subscription)
    },

    // Listen to download progress updates
    onProgressUpdate: (callback) => {
      const subscription = (event, data) => callback(data)
      ipcRenderer.on('updater-progress', subscription)

      // Return unsubscribe function
      return () => ipcRenderer.removeListener('updater-progress', subscription)
    },

    // Remove all updater listeners (cleanup)
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('updater-status')
      ipcRenderer.removeAllListeners('updater-progress')
    }
  },

  // Cache utility functions (PRESERVED)
  cache: {
    // Get cache statistics
    getStats: () => ipcRenderer.invoke('get-cache-stats'),

    // Clear caches
    clear: () => ipcRenderer.invoke('clear-profile-cache'),

    // Get fast profile
    getProfileFast: (barcode) => ipcRenderer.invoke('get-profile-fast', barcode),

    // Preload scanning session
    preloadScanningSession: (barcodes) => ipcRenderer.invoke('preload-scanning-session', barcodes)
  },

  // Event listeners for main process messages
  onShowExportDialog: (callback) => {
    ipcRenderer.on("show-export-dialog", callback)
    // Return a function to remove the listener
    return () => ipcRenderer.removeAllListeners("show-export-dialog")
  },

  onSyncAttendanceToServer: (callback) => {
    ipcRenderer.on("sync-attendance-to-server", callback)
    return () => ipcRenderer.removeAllListeners("sync-attendance-to-server")
  },

  // Summary sync event listener
  onSyncSummaryToServer: (callback) => {
    ipcRenderer.on("sync-summary-to-server", callback)
    return () => ipcRenderer.removeAllListeners("sync-summary-to-server")
  },

  // Data change event listeners
  onAttendanceDataChanged: (callback) => {
    ipcRenderer.on("attendance-data-changed", callback)
    return () => ipcRenderer.removeAllListeners("attendance-data-changed")
  },

  onSummaryDataChanged: (callback) => {
    ipcRenderer.on("summary-data-changed", callback)
    return () => ipcRenderer.removeAllListeners("summary-data-changed")
  },

  // Profile-related event listeners
  onProfileDownloadProgress: (callback) => {
    ipcRenderer.on("profile-download-progress", callback)
    return () => ipcRenderer.removeAllListeners("profile-download-progress")
  },

  onProfileDownloadComplete: (callback) => {
    ipcRenderer.on("profile-download-complete", callback)
    return () => ipcRenderer.removeAllListeners("profile-download-complete")
  },

  onProfileDownloadError: (callback) => {
    ipcRenderer.on("profile-download-error", callback)
    return () => ipcRenderer.removeAllListeners("profile-download-error")
  },

  // Cache update event listener (PRESERVED)
  onCacheUpdate: (callback) => {
    const subscription = (event, data) => callback(data)
    ipcRenderer.on('cache-update', subscription)
    return () => ipcRenderer.removeListener('cache-update', subscription)
  },

  // Utility functions
  platform: process.platform,
  versions: {
    node: process.versions.node,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
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
  fileExists: (filePath) => ipcRenderer.invoke("file-exists", filePath),
  readTextFile: (filePath) => ipcRenderer.invoke("read-text-file", filePath),
  writeTextFile: (filePath, content) => ipcRenderer.invoke("write-text-file", filePath, content),
  readFileAsBase64: (filePath) => ipcRenderer.invoke("read-file-as-base64", filePath),

  // Development mode detection
  isDev: process.env.NODE_ENV === "development" || process.argv.includes("--dev"),

  // Profile utility functions for the renderer (PRESERVED)
  profileUtils: {
    // Helper to check multiple profiles at once
    checkMultipleProfiles: async (uids) => {
      const results = await Promise.allSettled(
        uids.map(uid => ipcRenderer.invoke("profile-exists", uid))
      );
      return results.map((result, index) => ({
        uid: uids[index],
        exists: result.status === 'fulfilled' ? result.value.exists : false,
        error: result.status === 'rejected' ? result.reason : null
      }));
    },

    // Helper to get profile stats
    getProfileStats: async () => {
      try {
        const allProfiles = await ipcRenderer.invoke("check-all-profile-images");
        const dirInfo = await ipcRenderer.invoke("get-profiles-directory-info");

        return {
          totalProfiles: allProfiles.downloaded || 0,
          totalSize: allProfiles.totalSize || 0,
          profilesDirectory: dirInfo.path,
          directoryExists: dirInfo.exists,
          oldestProfile: allProfiles.oldestProfile,
          newestProfile: allProfiles.newestProfile,
          profiles: allProfiles.profiles || []
        };
      } catch (error) {
        return {
          error: error.message,
          totalProfiles: 0,
          totalSize: 0,
          profiles: []
        };
      }
    },

    // Helper to format file sizes
    formatFileSize: (bytes) => {
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    },

    // Helper to validate UIDs
    validateUids: (uids) => {
      if (!Array.isArray(uids)) {
        return { valid: false, error: 'UIDs must be an array' };
      }

      const invalidUids = uids.filter(uid => !Number.isInteger(uid) || uid <= 0);
      if (invalidUids.length > 0) {
        return {
          valid: false,
          error: `Invalid UIDs found: ${invalidUids.join(', ')}`
        };
      }

      return { valid: true, uids: [...new Set(uids)] }; // Remove duplicates
    }
  }
})

// Optional: Log when preload script is loaded
console.log("Preload script loaded successfully with enhanced profile operations, cache system, and auto-updater support")