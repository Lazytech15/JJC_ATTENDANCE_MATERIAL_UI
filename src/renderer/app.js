// Import SheetJS library
class AttendanceApp {
  constructor() {
    this.ws = null;
    this.employeeDisplayTimeout = null;
    this.imageLoadAttempts = new Map(); // Track image load attempts
    this.imageCounter = 0; // Counter for unique IDs
    this.barcodeTimeout = null; // Add timeout for barcode handling
    this.autoSyncInterval = null; // Auto-sync interval
    this.summaryAutoSyncInterval = null; // Summary auto-sync interval

    // NEW: Add scanning queue management
    this.scanQueue = [];
    this.isProcessingScan = false;
    this.maxQueueSize = 10; // Prevent memory issues

    this.syncSettings = {
      enabled: true,
      interval: 5 * 60 * 1000, // Default 5 minutes
      retryAttempts: 3,
      retryDelay: 30000, // 30 seconds
    };
    this.summarySyncSettings = {
      enabled: true,
      interval: 10 * 60 * 1000, // Default 10 minutes for summary
      retryAttempts: 3,
      retryDelay: 45000, // 45 seconds
    };
    this.electronAPI = window.electronAPI; // Use the exposed API

    // Duplicate prevention tracking
    this.lastScanData = {
      input: null,
      timestamp: 0,
      duplicatePreventionWindow: 60000, // 1 minute
    };

    // Track when daily summary needs to be synced
    this.pendingSummarySync = false;
    this.lastSummaryDataChange = null;

    this.init();

    this.currentDateRange = {
      startDate: null,
      endDate: null,
    };
    this.summaryData = [];
    this.initializeDateRangeControls();
  }

  async init() {
    this.setupEventListeners();
    this.startClock();
    this.connectWebSocket();
    await this.loadInitialData();
    await this.loadSyncSettings(); // Load sync settings from database
    this.startAutoSync(); // Start automatic attendance sync
    this.startSummaryAutoSync(); // Start automatic summary sync
    this.focusInput();
  }

  // Load sync settings from the database
  async loadSyncSettings() {
    if (!this.electronAPI) return;

    try {
      const result = await this.electronAPI.getSettings();
      if (result.success && result.data) {
        // Update sync interval from settings
        const syncInterval =
          Number.parseInt(result.data.sync_interval) || 5 * 60 * 1000;
        this.syncSettings.interval = syncInterval;

        // Load summary sync interval (default to double the attendance sync interval)
        const summarySyncInterval =
          Number.parseInt(result.data.summary_sync_interval) ||
          syncInterval * 2;
        this.summarySyncSettings.interval = summarySyncInterval;

        console.log(
          "Loaded sync settings - attendance interval:",
          syncInterval,
          "ms"
        );
        console.log(
          "Loaded sync settings - summary interval:",
          summarySyncInterval,
          "ms"
        );
      }
    } catch (error) {
      console.error("Error loading sync settings:", error);
    }
  }

  // Check if the current scan is a duplicate
  isDuplicateScan(input) {
    const currentTime = Date.now();
    const timeDifference = currentTime - this.lastScanData.timestamp;

    // Check if the same input was scanned within the prevention window
    if (
      this.lastScanData.input === input &&
      timeDifference < this.lastScanData.duplicatePreventionWindow
    ) {
      console.log(
        `Duplicate scan detected: "${input}" scanned ${timeDifference}ms ago (within ${this.lastScanData.duplicatePreventionWindow}ms window)`
      );
      return true;
    }

    return false;
  }

  // Update the last scan data
  updateLastScanData(input) {
    this.lastScanData.input = input;
    this.lastScanData.timestamp = Date.now();
  }

  // Start automatic attendance sync
  startAutoSync() {
    if (this.autoSyncInterval) {
      clearInterval(this.autoSyncInterval);
    }

    if (!this.syncSettings.enabled) return;

    console.log(
      "Starting auto-sync with interval:",
      this.syncSettings.interval,
      "ms"
    );

    this.autoSyncInterval = setInterval(() => {
      this.performAttendanceSync(true); // Silent sync
    }, this.syncSettings.interval);

    // Also perform an initial sync after 10 seconds with download toast
    setTimeout(() => {
      this.performAttendanceSync(true, 0, true); // Silent sync with initial download toast
    }, 10000);
  }

  // Start automatic summary sync
  startSummaryAutoSync() {
    if (this.summaryAutoSyncInterval) {
      clearInterval(this.summaryAutoSyncInterval);
    }

    if (!this.summarySyncSettings.enabled) return;

    console.log(
      "Starting summary auto-sync with interval:",
      this.summarySyncSettings.interval,
      "ms"
    );

    this.summaryAutoSyncInterval = setInterval(() => {
      this.performSummarySync(true); // Silent sync
    }, this.summarySyncSettings.interval);

    // Also perform an initial sync after 15 seconds
    setTimeout(() => {
      this.performSummarySync(true, 0, true); // Silent sync with initial download toast
    }, 15000);
  }

  // Stop automatic sync
  stopAutoSync() {
    if (this.autoSyncInterval) {
      clearInterval(this.autoSyncInterval);
      this.autoSyncInterval = null;
      console.log("Auto-sync stopped");
    }

    if (this.summaryAutoSyncInterval) {
      clearInterval(this.summaryAutoSyncInterval);
      this.summaryAutoSyncInterval = null;
      console.log("Summary auto-sync stopped");
    }
  }

  async performAttendanceSync(
  silent = false,
  retryCount = 0,
  showDownloadToast = false
) {
  if (!this.electronAPI) {
    if (!silent) {
      this.showStatus("Demo mode: Sync simulated successfully!", "success");
    }
    return { success: true, message: "Demo sync" };
  }

  try {
    // First validate unsynced records before syncing
    if (retryCount === 0) { // Only validate on first attempt, not retries
      try {
        if (!silent) {
          this.showStatus("Validating attendance data before sync...", "info");
        }
        
        const validationResult = await this.electronAPI.validateAndCorrectUnsyncedRecords({
          autoCorrect: true,
          updateSyncStatus: false // Don't change sync status during validation
        });
        
        if (validationResult.success && validationResult.data.summary.correctedRecords > 0) {
          const corrected = validationResult.data.summary.correctedRecords;
          console.log(`Pre-sync validation: ${corrected} records corrected`);
          
          if (!silent) {
            this.showStatus(`Validated and corrected ${corrected} records before sync`, "success");
          }
        }
      } catch (validationError) {
        console.warn("Pre-sync validation failed, continuing with sync:", validationError);
      }
    }

    // First check if there are attendance records to sync
    const countResult = await this.electronAPI.getUnsyncedAttendanceCount();

    if (!countResult.success || countResult.count === 0) {
      if (!silent) {
        this.showStatus("No attendance records to sync", "info");
      }

      // Even if no attendance records, check for summary records
      return await this.performSummarySync(
        silent,
        retryCount,
        showDownloadToast
      );
    }

    // Show download toast for initial sync or when explicitly requested
    if (showDownloadToast || (!silent && retryCount === 0)) {
      this.showDownloadToast(
        `📤 Uploading ${countResult.count} attendance records to server...`,
        "info"
      );
    } else if (!silent) {
      this.showStatus(
        `Syncing ${countResult.count} attendance records...`,
        "info"
      );
    }

    // Perform the attendance sync
    const syncResult = await this.electronAPI.syncAttendanceToServer();

    if (syncResult.success) {
      if (showDownloadToast || !silent) {
        this.showDownloadToast(
          "✅ Attendance data uploaded successfully!",
          "success"
        );
      }
      console.log("Attendance sync successful:", syncResult.message);

      // Update sync info display if settings modal is open
      if (
        document.getElementById("settingsModal").classList.contains("show")
      ) {
        await this.loadSyncInfo();
      }

      // After successful attendance sync, perform summary sync
      console.log("Triggering summary sync after attendance sync");
      const summaryResult = await this.performSummarySync(true, 0, false); // Silent summary sync

      return {
        success: true,
        message: syncResult.message,
        attendanceSync: syncResult,
        summarySync: summaryResult,
      };
    } else {
      throw new Error(syncResult.message);
    }
  } catch (error) {
    console.error("Attendance sync error:", error);

    // Retry logic
    if (retryCount < this.syncSettings.retryAttempts) {
      console.log(
        `Retrying sync in ${
          this.syncSettings.retryDelay / 1000
        } seconds... (attempt ${retryCount + 1}/${
          this.syncSettings.retryAttempts
        })`
      );

      setTimeout(() => {
        this.performAttendanceSync(silent, retryCount + 1, showDownloadToast);
      }, this.syncSettings.retryDelay);

      if (showDownloadToast || !silent) {
        this.showDownloadToast(
          `⚠️ Upload failed, retrying... (${retryCount + 1}/${
            this.syncSettings.retryAttempts
          })`,
          "warning"
        );
      }
    } else {
      if (showDownloadToast || !silent) {
        this.showDownloadToast(
          `❌ Upload failed after ${this.syncSettings.retryAttempts} attempts: ${error.message}`,
          "error"
        );
      }
      return { success: false, message: error.message };
    }
  }
}

  async performSummarySync(
    silent = false,
    retryCount = 0,
    showDownloadToast = false
  ) {
    if (!this.electronAPI) {
      if (!silent) {
        this.showStatus(
          "Demo mode: Summary sync simulated successfully!",
          "success"
        );
      }
      return { success: true, message: "Demo summary sync" };
    }

    try {
      // Check if there are summary records to sync
      const countResult = await this.electronAPI.getUnsyncedDailySummaryCount();

      if (!countResult.success || countResult.count === 0) {
        if (!silent) {
          this.showStatus("No daily summary records to sync", "info");
        }
        return { success: true, message: "No summary records to sync" };
      }

      // Show download toast for initial sync or when explicitly requested
      if (showDownloadToast || (!silent && retryCount === 0)) {
        this.showDownloadToast(
          `📊 Uploading ${countResult.count} daily summary records to server...`,
          "info"
        );
      } else if (!silent) {
        this.showStatus(
          `Syncing ${countResult.count} daily summary records...`,
          "info"
        );
      }

      // Perform the summary sync
      const syncResult = await this.electronAPI.syncDailySummaryToServer();

      if (syncResult.success) {
        if (showDownloadToast || !silent) {
          this.showDownloadToast(
            "✅ Daily summary data uploaded successfully!",
            "success"
          );
        }
        console.log("Daily summary sync successful:", syncResult.message);

        // Update sync info display if settings modal is open
        if (
          document.getElementById("settingsModal").classList.contains("show")
        ) {
          await this.loadSyncInfo();
        }

        // Reset pending summary sync flag if it exists
        if (this.pendingSummarySync) {
          this.pendingSummarySync = false;
        }

        return syncResult;
      } else {
        throw new Error(syncResult.message);
      }
    } catch (error) {
      console.error("Daily summary sync error:", error);

      // Retry logic
      if (retryCount < this.syncSettings.retryAttempts) {
        console.log(
          `Retrying summary sync in ${
            this.syncSettings.retryDelay / 1000
          } seconds... (attempt ${retryCount + 1}/${
            this.syncSettings.retryAttempts
          })`
        );

        setTimeout(() => {
          this.performSummarySync(silent, retryCount + 1, showDownloadToast);
        }, this.syncSettings.retryDelay);

        if (showDownloadToast || !silent) {
          this.showDownloadToast(
            `⚠️ Summary upload failed, retrying... (${retryCount + 1}/${
              this.syncSettings.retryAttempts
            })`,
            "warning"
          );
        }
      } else {
        if (showDownloadToast || !silent) {
          this.showDownloadToast(
            `❌ Summary upload failed after ${this.syncSettings.retryAttempts} attempts: ${error.message}`,
            "error"
          );
        }

        // Set pending summary sync flag for later retry
        this.pendingSummarySync = true;

        return { success: false, message: error.message };
      }
    }
  }

  // Helper method to perform both syncs sequentially
  async performFullSync(silent = false, showDownloadToast = true) {
    console.log("Starting full sync (attendance + summary)");

    try {
      const result = await this.performAttendanceSync(
        silent,
        0,
        showDownloadToast
      );

      if (result.success) {
        console.log("Full sync completed successfully");
        return result;
      } else {
        console.error("Full sync failed:", result.message);
        return result;
      }
    } catch (error) {
      console.error("Full sync error:", error);
      return { success: false, message: error.message };
    }
  }

  // Helper method to force sync all data (both attendance and summary)
  async performForceSyncAll(silent = false, showDownloadToast = true) {
    if (!this.electronAPI) {
      if (!silent) {
        this.showStatus(
          "Demo mode: Force sync simulated successfully!",
          "success"
        );
      }
      return { success: true, message: "Demo force sync" };
    }

    try {
      if (showDownloadToast || !silent) {
        this.showDownloadToast(
          "🔄 Force syncing all data to server...",
          "info"
        );
      }

      // Force sync attendance data
      const attendanceResult = await this.electronAPI.forceSyncAllAttendance();

      // Force sync summary data
      const summaryResult = await this.electronAPI.forceSyncAllDailySummary();

      if (attendanceResult.success && summaryResult.success) {
        if (showDownloadToast || !silent) {
          this.showDownloadToast(
            `✅ Force sync completed! ${attendanceResult.syncedCount} attendance + ${summaryResult.syncedCount} summary records uploaded`,
            "success"
          );
        }

        // Update sync info display if settings modal is open
        if (
          document.getElementById("settingsModal").classList.contains("show")
        ) {
          await this.loadSyncInfo();
        }

        return {
          success: true,
          message: "Force sync completed successfully",
          attendanceSync: attendanceResult,
          summarySync: summaryResult,
        };
      } else {
        const errors = [];
        if (!attendanceResult.success)
          errors.push(`Attendance: ${attendanceResult.message}`);
        if (!summaryResult.success)
          errors.push(`Summary: ${summaryResult.message}`);

        throw new Error(errors.join("; "));
      }
    } catch (error) {
      console.error("Force sync error:", error);

      if (showDownloadToast || !silent) {
        this.showDownloadToast(
          `❌ Force sync failed: ${error.message}`,
          "error"
        );
      }

      return { success: false, message: error.message };
    }
  }

  // NEW: Perform summary sync with similar pattern to attendance sync
  async performSummarySync(
    silent = false,
    retryCount = 0,
    showDownloadToast = false
  ) {
    if (!this.electronAPI) {
      if (!silent) {
        this.showStatus(
          "Demo mode: Summary sync simulated successfully!",
          "success"
        );
      }
      return { success: true, message: "Demo summary sync" };
    }

    try {
      // First check if there are summary records to sync
      const countResult = await this.electronAPI.getUnsyncedDailySummaryCount();

      if (!countResult.success || countResult.count === 0) {
        if (!silent) {
          this.showStatus("No daily summary records to sync", "info");
        }
        // Reset pending sync flag if no data to sync
        this.pendingSummarySync = false;
        return { success: true, message: "No summary records to sync" };
      }

      // Show download toast for initial sync or when explicitly requested
      if (showDownloadToast || (!silent && retryCount === 0)) {
        this.showDownloadToast(
          `📊 Uploading ${countResult.count} daily summary records to server...`,
          "info"
        );
      } else if (!silent) {
        this.showStatus(
          `Syncing ${countResult.count} daily summary records...`,
          "info"
        );
      }

      // Perform the summary sync
      const syncResult = await this.electronAPI.syncDailySummaryToServer();

      if (syncResult.success) {
        if (showDownloadToast || !silent) {
          this.showDownloadToast(
            "✅ Daily summary data uploaded successfully!",
            "success"
          );
        }
        console.log("Summary sync successful:", syncResult.message);

        // Reset pending sync flag
        this.pendingSummarySync = false;
        this.lastSummaryDataChange = null;

        // Update sync info display if settings modal is open
        if (
          document.getElementById("settingsModal").classList.contains("show")
        ) {
          await this.loadSummaryInfo();
        }

        return syncResult;
      } else {
        throw new Error(syncResult.message);
      }
    } catch (error) {
      console.error("Summary sync error:", error);

      // Retry logic
      if (retryCount < this.summarySyncSettings.retryAttempts) {
        console.log(
          `Retrying summary sync in ${
            this.summarySyncSettings.retryDelay / 1000
          } seconds... (attempt ${retryCount + 1}/${
            this.summarySyncSettings.retryAttempts
          })`
        );

        setTimeout(() => {
          this.performSummarySync(silent, retryCount + 1, showDownloadToast);
        }, this.summarySyncSettings.retryDelay);

        if (showDownloadToast || !silent) {
          this.showDownloadToast(
            `⚠️ Summary upload failed, retrying... (${retryCount + 1}/${
              this.summarySyncSettings.retryAttempts
            })`,
            "warning"
          );
        }
      } else {
        if (showDownloadToast || !silent) {
          this.showDownloadToast(
            `❌ Summary upload failed after ${this.summarySyncSettings.retryAttempts} attempts: ${error.message}`,
            "error"
          );
        }
        return { success: false, message: error.message };
      }
    }
  }

  // NEW: Mark that summary data has changed and needs syncing
  markSummaryDataChanged() {
    this.pendingSummarySync = true;
    this.lastSummaryDataChange = Date.now();
    console.log("Summary data marked as changed, pending sync");
  }

 async saveAndSync() {
  const syncNowBtn = document.getElementById("syncNowBtn");
  const originalText = syncNowBtn.textContent;

  // Show loading state
  syncNowBtn.textContent = "💾 Saving & Syncing...";
  syncNowBtn.disabled = true;

  if (!this.electronAPI) {
    this.showSettingsStatus(
      "Demo mode: Settings saved and sync completed successfully!",
      "success"
    );
    this.showDownloadToast(
      "📊 Demo: Employee data downloaded successfully!",
      "success"
    );
    await this.loadSyncInfo();
    syncNowBtn.textContent = originalText;
    syncNowBtn.disabled = false;
    return;
  }

  try {
    // First, save the settings
    const settingsForm = document.getElementById("settingsForm");
    if (!settingsForm) {
      throw new Error("Settings form not found");
    }

    const formData = new FormData(settingsForm);

    // Get server URL with proper null checking
    const serverUrlInput =
      formData.get("serverUrl") ||
      document.getElementById("serverUrl")?.value;
    if (!serverUrlInput) {
      this.showSettingsStatus("Server URL is required", "error");
      return;
    }

    // Clean the base URL and ensure it doesn't already have the API endpoint
    let baseUrl = serverUrlInput.toString().trim().replace(/\/$/, ""); // Remove trailing slash
    if (baseUrl.endsWith("/api/tables/emp_list/data")) {
      baseUrl = baseUrl.replace("/api/tables/emp_list/data", "");
    }

    const fullServerUrl = `${baseUrl}/api/tables/emp_list/data`;

    // Get other form values with fallbacks
    const syncIntervalInput =
      formData.get("syncInterval") ||
      document.getElementById("syncInterval")?.value ||
      "5";
    const gracePeriodInput =
      formData.get("gracePeriod") ||
      document.getElementById("gracePeriod")?.value ||
      "5";
    const summarySyncIntervalInput =
      formData.get("summarySyncInterval") ||
      document.getElementById("summarySyncInterval")?.value ||
      "10";

    const settings = {
      server_url: fullServerUrl,
      sync_interval: (Number.parseInt(syncIntervalInput) * 60000).toString(),
      summary_sync_interval: (
        Number.parseInt(summarySyncIntervalInput) * 60000
      ).toString(),
      grace_period: gracePeriodInput,
    };

    console.log("Saving settings:", settings); // Debug log

    const saveResult = await this.electronAPI.updateSettings(settings);

    if (!saveResult.success) {
      this.showSettingsStatus(
        saveResult.error || "Error saving settings",
        "error"
      );
      return;
    }

    // Update local sync settings
    this.syncSettings.interval = Number.parseInt(settings.sync_interval);
    this.summarySyncSettings.interval = Number.parseInt(
      settings.summary_sync_interval
    );

    // Restart auto-sync with new intervals
    this.startAutoSync();
    this.startSummaryAutoSync();

    // Update button text and show download toast for validation phase
    syncNowBtn.textContent = "🔍 Validating Data...";
    this.showDownloadToast(
      "🔄 Validating attendance calculations...",
      "info"
    );

    // Validate all attendance data before sync
    const validationResult = await this.electronAPI.validateAttendanceData({
      autoCorrect: true,
      updateSyncStatus: true,
      validateStatistics: true,
      rebuildSummary: true
    });

    if (validationResult.success && validationResult.data) {
      // Access the validation data directly (not through a summary property)
      const validationData = validationResult.data;
      
      // Check if we have the expected structure and show appropriate message
      if (validationData.totalRecords !== undefined) {
        const correctedRecords = validationData.correctedRecords || 0;
        const totalRecords = validationData.totalRecords || 0;
        
        if (correctedRecords > 0) {
          this.showDownloadToast(
            `✅ Validated ${totalRecords} records (${correctedRecords} corrections)`,
            "success"
          );
        } else {
          this.showDownloadToast(
            `✅ All ${totalRecords} records validated successfully`,
            "success"
          );
        }
      } else {
        // Fallback message if structure is different
        this.showDownloadToast("✅ Attendance validation completed", "success");
      }
    } else {
      // Log warning but don't stop the sync process
      console.warn("Attendance validation had issues:", validationResult.error);
      this.showDownloadToast("⚠️ Validation completed with warnings", "warning");
    }

    // Update button text and show download toast for employee sync phase
    syncNowBtn.textContent = "📥 Downloading Employees...";
    this.showDownloadToast(
      "🔄 Connecting to server and downloading employee data...",
      "info"
    );

    // Then sync the employees
    const employeeSyncResult = await this.electronAPI.syncEmployees();

    if (!employeeSyncResult.success) {
      this.showSettingsStatus(
        `Settings saved, but employee sync failed: ${employeeSyncResult.error}`,
        "warning"
      );
      this.showDownloadToast(
        "❌ Failed to download employee data from server",
        "error"
      );
      return;
    }

    // Show success toast for employee download
    this.showDownloadToast(
      "✅ Employee data downloaded successfully!",
      "success"
    );

    // Update button text to show attendance sync phase
    syncNowBtn.textContent = "📊 Uploading Attendance...";

    // Then sync attendance with download toast
    const attendanceSyncResult = await this.performAttendanceSync(
      false,
      0,
      true
    );

    // Update button text to show summary sync phase
    syncNowBtn.textContent = "📈 Uploading Summary...";

    // Finally sync summary data
    const summarySyncResult = await this.performSummarySync(false, 0, true);

    if (
      attendanceSyncResult &&
      attendanceSyncResult.success &&
      summarySyncResult &&
      summarySyncResult.success
    ) {
      this.showSettingsStatus(
        "Settings saved, data validated, and all synced successfully!",
        "success"
      );
      await this.loadSyncInfo();
      await this.loadSummaryInfo();
      // Also refresh the main attendance data
      await this.loadTodayAttendance();
    } else if (attendanceSyncResult && attendanceSyncResult.success) {
      this.showSettingsStatus(
        "Settings saved, attendance synced, but summary sync had issues",
        "warning"
      );
    } else {
      this.showSettingsStatus(
        "Settings saved, employees synced, but data sync had issues",
        "warning"
      );
    }
  } catch (error) {
    console.error("Save and sync error:", error);
    this.showSettingsStatus(
      `Error occurred during save and sync: ${error.message}`,
      "error"
    );
    this.showDownloadToast("❌ Connection to server failed", "error");
  } finally {
    syncNowBtn.textContent = originalText;
    syncNowBtn.disabled = false;
  }
}

  // New method for download-specific toast messages
  showDownloadToast(message, type = "info") {
    // Create or get download-specific toast element
    let downloadToast = document.getElementById("downloadToast");

    if (!downloadToast) {
      downloadToast = document.createElement("div");
      downloadToast.id = "downloadToast";
      downloadToast.className = "download-toast";
      document.body.appendChild(downloadToast);
    }

    downloadToast.textContent = message;
    downloadToast.className = `download-toast ${type} show`;

    // Clear any existing timeout
    if (downloadToast.hideTimeout) {
      clearTimeout(downloadToast.hideTimeout);
    }

    // Auto-hide after appropriate duration based on type
    const duration = type === "error" ? 6000 : type === "warning" ? 5000 : 4000;
    downloadToast.hideTimeout = setTimeout(() => {
      downloadToast.classList.remove("show");
    }, duration);
  }

  setupEventListeners() {
    // Barcode input
    const barcodeInput = document.getElementById("barcodeInput");
    const manualSubmit = document.getElementById("manualSubmit");
    const settingsBtn = document.getElementById("settingsBtn");
    const closeSettings = document.getElementById("closeSettings");
    const cancelSettings = document.getElementById("cancelSettings");
    const settingsModal = document.getElementById("settingsModal");
    const settingsForm = document.getElementById("settingsForm");
    const syncNowBtn = document.getElementById("syncNowBtn");


barcodeInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    this.handleScan(); // This now adds to queue instead of processing immediately
  }
});

    barcodeInput.addEventListener("input", (e) => {
      const inputType = document.querySelector(
        'input[name="inputType"]:checked'
      ).value;

      // Clear any existing timeout
      if (this.barcodeTimeout) {
        clearTimeout(this.barcodeTimeout);
      }

      if (inputType === "barcode") {
        this.barcodeTimeout = setTimeout(() => {
          const currentValue = e.target.value.trim();
          if (currentValue.length >= 8) {
            this.handleScan();
          }
        }, 2000);
      }
    });

    // Handle paste events (some barcode scanners simulate paste)
    barcodeInput.addEventListener("paste", (e) => {
      const inputType = document.querySelector(
        'input[name="inputType"]:checked'
      ).value;

      if (inputType === "barcode") {
        setTimeout(() => {
          const pastedValue = e.target.value.trim();
          if (pastedValue.length >= 8) {
            this.handleScan();
          }
        }, 2000);
      }
    });

    manualSubmit.addEventListener("click", () => {
      this.handleScan();
    });

    // Settings event listeners
    settingsBtn.addEventListener("click", () => {
      this.openSettings();
    });

    closeSettings.addEventListener("click", () => {
      this.closeSettings();
    });

    cancelSettings.addEventListener("click", () => {
      this.closeSettings();
    });

    settingsModal.addEventListener("click", (e) => {
      if (e.target === settingsModal) {
        this.closeSettings();
      }
    });

    // Settings form submission - now calls saveAndSync
    settingsForm.addEventListener("submit", (e) => {
      e.preventDefault();
      this.saveAndSync();
    });

    // Sync now button - now calls saveAndSync
    syncNowBtn.addEventListener("click", () => {
      this.saveAndSync();
    });

    // Add manual attendance sync button functionality
    const syncAttendanceBtn = document.getElementById("syncAttendanceBtn");
    if (syncAttendanceBtn) {
      syncAttendanceBtn.addEventListener("click", () => {
        this.performAttendanceSync(false, 0, true); // Not silent, with download toast
      });
    }

    // NEW: Add manual summary sync button functionality
    const syncSummaryBtn = document.getElementById("syncSummaryBtn");
    if (syncSummaryBtn) {
      syncSummaryBtn.addEventListener("click", () => {
        this.performSummarySync(false, 0, true); // Not silent, with download toast
      });
    }

    // Keep input focused but allow interaction with employee display
    document.addEventListener("click", (e) => {
      if (
        !e.target.closest(".employee-display") &&
        !e.target.closest("button") &&
        !e.target.closest("input")
      ) {
        this.focusInput();
      }
    });

    // Handle input type changes
    const inputTypeRadios = document.querySelectorAll(
      'input[name="inputType"]'
    );
    inputTypeRadios.forEach((radio) => {
      radio.addEventListener("change", () => {
        this.focusInput();
        // Clear any pending timeouts when switching input types
        if (this.barcodeTimeout) {
          clearTimeout(this.barcodeTimeout);
        }
      });
    });

    // Listen for IPC events from main process using the exposed API
    if (this.electronAPI) {
      // Set up listener for sync attendance events
      this.electronAPI.onSyncAttendanceToServer(() => {
        this.performAttendanceSync(false, 0, true); // Show download toast
      });
    }

    const downloadBtn = document.getElementById("downloadExcelBtn");
    if (downloadBtn) {
      downloadBtn.addEventListener("click", () => this.downloadExcel());
    }
  }

  // Enhanced sync employees with download toast
  async syncEmployees() {
    try {
      // Show download toast when syncing employees
      this.showDownloadToast(
        "📥 Downloading employee data from server...",
        "info"
      );

      const result = await this.electronAPI.syncEmployees();

      if (result.success) {
        this.showDownloadToast(
          "✅ Employee data downloaded successfully!",
          "success"
        );
        this.showStatus(result.message, "success");
      } else {
        this.showDownloadToast("❌ Failed to download employee data", "error");
        console.warn("Sync warning:", result.error);
      }
    } catch (error) {
      console.error("Sync error:", error);
      this.showDownloadToast("❌ Connection to server failed", "error");
    }
  }

  // Settings functionality
  openSettings() {
    const modal = document.getElementById("settingsModal");
    modal.classList.add("show");
    this.loadSettings();
    this.loadSyncInfo();
    this.loadSummaryInfo(); // NEW: Load summary sync info
    this.loadAttendanceSyncInfo();
    this.loadDailySummary();
    this.initializeSettingsTabs();
  }

  closeSettings() {
    const modal = document.getElementById("settingsModal");
    modal.classList.remove("show");
    // Clear any status messages
    const statusElement = document.getElementById("settingsStatusMessage");
    statusElement.style.display = "none";
  }

  initializeSettingsTabs() {
    const tabs = document.querySelectorAll(".settings-tab");
    const panels = document.querySelectorAll(".settings-panel");

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        // Remove active class from all tabs and panels
        tabs.forEach((t) => t.classList.remove("active"));
        panels.forEach((p) => p.classList.remove("active"));

        // Add active class to clicked tab
        tab.classList.add("active");

        // Show corresponding panel
        const targetPanel = document.getElementById(tab.dataset.tab + "Panel");
        if (targetPanel) {
          targetPanel.classList.add("active");
        }

        // Load data for specific tabs
        if (tab.dataset.tab === "reports") {
          this.loadDailySummary();
        } else if (tab.dataset.tab === "sync") {
          this.loadSyncInfo();
          this.loadSummaryInfo(); // NEW: Load summary info when sync tab is opened
          this.loadAttendanceSyncInfo();
        }
      });
    });
  }

  async loadSettings() {
    if (!this.electronAPI) {
      // Demo values
      document.getElementById("serverUrl").value = "URL";
      document.getElementById("syncInterval").value = "5";
      document.getElementById("gracePeriod").value = "5";
      document.getElementById("summarySyncInterval").value = "10"; // NEW: Demo summary sync interval
      return;
    }

    try {
      const result = await this.electronAPI.getSettings();

      if (result.success) {
        const settings = result.data;

        document.getElementById("serverUrl").value = settings.server_url || "";
        document.getElementById("syncInterval").value = Math.floor(
          (settings.sync_interval || 300000) / 60000
        );
        document.getElementById("gracePeriod").value =
          settings.grace_period || 5;
        // NEW: Load summary sync interval setting
        document.getElementById("summarySyncInterval").value = Math.floor(
          (settings.summary_sync_interval || 600000) / 60000
        );
      }
    } catch (error) {
      console.error("Error loading settings:", error);
      this.showSettingsStatus("Error loading settings", "error");
    }
  }

  async loadSyncInfo() {
  if (!this.electronAPI) {
    document.getElementById("employeeCount").textContent =
      "Employees in database: 25 (Demo)";
    document.getElementById("lastSync").textContent =
      "Last sync: Just now (Demo)";
    document.getElementById("profileStatus").textContent =
      "Profile images: 20/25 downloaded (Demo)";
    document.getElementById("syncInfo").style.display = "block";
    return;
  }

  try {
    const employeesResult = await this.electronAPI.getEmployees();

    if (employeesResult.success) {
      document.getElementById(
        "employeeCount"
      ).textContent = `Employees in database: ${employeesResult.data.length}`;

      const settingsResult = await this.electronAPI.getSettings();
      if (settingsResult.success && settingsResult.data.last_sync) {
        const lastSync = new Date(
          Number.parseInt(settingsResult.data.last_sync)
        );
        document.getElementById(
          "lastSync"
        ).textContent = `Last sync: ${lastSync.toLocaleString()}`;
      } else {
        document.getElementById("lastSync").textContent = "Last sync: Never";
      }

      // FIXED: Extract UIDs from employees and pass to checkProfileImages
      const employeeUids = employeesResult.data.map(emp => emp.uid);
      const profileResult = await this.electronAPI.checkProfileImages(employeeUids);
      
      if (profileResult.success) {
        document.getElementById(
          "profileStatus"
        ).textContent = `Profile images: ${profileResult.downloaded}/${profileResult.total} downloaded`;
      } else {
        document.getElementById(
          "profileStatus"
        ).textContent = `Profile images: Error checking profiles`;
      }

      document.getElementById("syncInfo").style.display = "block";
    }
  } catch (error) {
    console.error("Error loading sync info:", error);
    document.getElementById("profileStatus").textContent = 
      "Profile images: Error loading info";
  }
}

  // NEW: Load summary sync information
  async loadSummaryInfo() {
    if (!this.electronAPI) {
      // Demo values
      const summarySyncInfo = document.getElementById("summarySyncInfo");
      if (summarySyncInfo) {
        summarySyncInfo.innerHTML = `
          <div class="sync-info-item">
            <strong>Unsynced Summary Records:</strong> 5 (Demo)
          </div>
          <div class="sync-info-item">
            <strong>Summary Auto-sync:</strong> Enabled - Every 10 minutes
          </div>
          <div class="sync-info-item">
            <strong>Last Summary Sync:</strong> 5 minutes ago (Demo)
          </div>
        `;
      }
      return;
    }

    try {
      const unsyncedResult =
        await this.electronAPI.getUnsyncedDailySummaryCount();
      const lastSyncResult =
        await this.electronAPI.getDailySummaryLastSyncTime();
      const summarySyncInfo = document.getElementById("summarySyncInfo");

      if (summarySyncInfo) {
        const syncIntervalMinutes = Math.floor(
          this.summarySyncSettings.interval / 60000
        );
        const syncStatus = this.summarySyncSettings.enabled
          ? `Enabled - Every ${syncIntervalMinutes} minutes`
          : "Disabled";

        let lastSyncText = "Never";
        if (
          lastSyncResult.success &&
          lastSyncResult.lastSync &&
          lastSyncResult.lastSync !== "1970-01-01T00:00:00.000Z"
        ) {
          const lastSyncDate = new Date(lastSyncResult.lastSync);
          const now = new Date();
          const minutesAgo = Math.floor((now - lastSyncDate) / (1000 * 60));
          lastSyncText =
            minutesAgo < 1 ? "Just now" : `${minutesAgo} minutes ago`;
        }

        summarySyncInfo.innerHTML = `
          <div class="sync-info-item">
            <strong>Unsynced Summary Records:</strong> ${
              unsyncedResult.success ? unsyncedResult.count : 0
            }
          </div>
          <div class="sync-info-item">
            <strong>Summary Auto-sync:</strong> ${syncStatus}
          </div>
          <div class="sync-info-item">
            <strong>Last Summary Sync:</strong> ${lastSyncText}
          </div>
          <div class="sync-info-item">
            <strong>Pending Sync:</strong> ${
              this.pendingSummarySync ? "Yes" : "No"
            }
          </div>
        `;
      }
    } catch (error) {
      console.error("Error loading summary sync info:", error);
    }
  }

  // Load attendance sync information
  async loadAttendanceSyncInfo() {
    if (!this.electronAPI) {
      // Demo values
      const attendanceSyncInfo = document.getElementById("attendanceSyncInfo");
      if (attendanceSyncInfo) {
        attendanceSyncInfo.innerHTML = `
          <div class="sync-info-item">
            <strong>Unsynced Records:</strong> 3 (Demo)
          </div>
          <div class="sync-info-item">
            <strong>Auto-sync:</strong> Enabled - Every 5 minutes
          </div>
          <div class="sync-info-item">
            <strong>Last Attendance Sync:</strong> 2 minutes ago (Demo)
          </div>
        `;
      }
      return;
    }

    try {
      const unsyncedResult =
        await this.electronAPI.getUnsyncedAttendanceCount();
      const attendanceSyncInfo = document.getElementById("attendanceSyncInfo");

      if (attendanceSyncInfo && unsyncedResult.success) {
        const syncIntervalMinutes = Math.floor(
          this.syncSettings.interval / 60000
        );
        const syncStatus = this.syncSettings.enabled
          ? `Enabled - Every ${syncIntervalMinutes} minutes`
          : "Disabled";

        attendanceSyncInfo.innerHTML = `
          <div class="sync-info-item">
            <strong>Unsynced Records:</strong> ${unsyncedResult.count}
          </div>
          <div class="sync-info-item">
            <strong>Auto-sync:</strong> ${syncStatus}
          </div>
          <div class="sync-info-item">
            <strong>Next sync:</strong> <span id="nextSyncTime">Calculating...</span>
          </div>
        `;

        // Update next sync time if auto-sync is enabled
        if (this.syncSettings.enabled && this.autoSyncInterval) {
          this.updateNextSyncTime();
        }
      }
    } catch (error) {
      console.error("Error loading attendance sync info:", error);
    }
  }

  // Update next sync countdown
  updateNextSyncTime() {
    // This is a simplified version - in a real app you might want to track the exact next sync time
    const nextSyncElement = document.getElementById("nextSyncTime");
    if (nextSyncElement) {
      const minutes = Math.floor(this.syncSettings.interval / 60000);
      nextSyncElement.textContent = `~${minutes} minutes`;
    }
  }

  showSettingsStatus(message, type = "info") {
    const statusElement = document.getElementById("settingsStatusMessage");
    statusElement.textContent = message;
    statusElement.className = `status-message ${type}`;
    statusElement.style.display = "block";
    statusElement.style.position = "relative";
    statusElement.style.top = "auto";
    statusElement.style.right = "auto";
    statusElement.style.transform = "none";
    statusElement.style.marginBottom = "16px";
    statusElement.style.borderRadius = "8px";

    setTimeout(() => {
      statusElement.style.display = "none";
    }, 4000);
  }

  focusInput() {
    const barcodeInput = document.getElementById("barcodeInput");
    setTimeout(() => {
      barcodeInput.focus();
      barcodeInput.select(); // Select all text for easy replacement
    }, 100);
  }

  // Generate unique ID for images
  generateUniqueId(prefix) {
    return `${prefix}-${++this.imageCounter}-${Date.now()}`;
  }

  startClock() {
    const updateClock = () => {
      const now = new Date();
      const options = {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      };
      document.getElementById("datetime").textContent = now.toLocaleDateString(
        "en-US",
        options
      );
    };

    updateClock();
    setInterval(updateClock, 1000);
  }

  connectWebSocket() {
    try {

      this.ws = new WebSocket("ws://localhost:8080");

      this.ws.onopen = () => {
        console.log("WebSocket connected");
        this.updateConnectionStatus(true);
      };

      this.ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        this.handleWebSocketMessage(message);
      };

      this.ws.onclose = () => {
        console.log("WebSocket disconnected");
        this.updateConnectionStatus(false);
        // Reconnect after 5 seconds
        setTimeout(() => this.connectWebSocket(), 5000);
      };

      this.ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        this.updateConnectionStatus(false);
      };
    } catch (error) {
      console.error("Failed to connect WebSocket:", error);
      this.updateConnectionStatus(false);
    }
  }

  updateConnectionStatus(isOnline) {
    const statusElement = document.getElementById("connectionStatus");
    const dot = statusElement.querySelector(".status-dot");
    const text = statusElement.querySelector("span:last-child");

    if (isOnline) {
      dot.classList.add("online");
      text.textContent = "Online";
    } else {
      dot.classList.remove("online");
      text.textContent = "Offline";
    }
  }

  handleWebSocketMessage(message) {
    switch (message.type) {
      case "attendance_update":
        this.loadTodayAttendance();
        // Mark summary data as changed since attendance affects summary
        this.markSummaryDataChanged();
        // Trigger sync after attendance update
        setTimeout(() => {
          this.performAttendanceSync(true); // Silent sync
        }, 2000);
        break;
      case "summary_update": // NEW: Handle summary-specific updates
        this.markSummaryDataChanged();
        // Trigger summary sync
        setTimeout(() => {
          this.performSummarySync(true); // Silent summary sync
        }, 3000);
        break;
      default:
        console.log("Unknown WebSocket message:", message);
    }
  }

  // Show loading screen to prevent duplicate scans
  showLoadingScreen() {
    // Create loading screen if it doesn't exist
    let loadingScreen = document.getElementById("loadingScreen");

    if (!loadingScreen) {
      loadingScreen = document.createElement("div");
      loadingScreen.id = "loadingScreen";
      loadingScreen.className = "loading-screen";
      loadingScreen.innerHTML = `
        <div class="loading-content">
          <div class="loading-spinner"></div>
          <div class="loading-text">Processing attendance...</div>
          <div class="loading-subtext">Please wait</div>
        </div>
      `;
      document.body.appendChild(loadingScreen);
    }

    loadingScreen.style.display = "flex";
    // Add fade-in effect
    setTimeout(() => {
      loadingScreen.classList.add("show");
    }, 5);
  }

  // Hide loading screen
  hideLoadingScreen() {
    const loadingScreen = document.getElementById("loadingScreen");
    if (loadingScreen) {
      loadingScreen.classList.remove("show");
      setTimeout(() => {
        loadingScreen.style.display = "none";
      }, 250); // Wait for fade-out animation
    }
  }

  async handleScan() {
  // Clear any pending timeouts
  if (this.barcodeTimeout) {
    clearTimeout(this.barcodeTimeout);
  }

  const input = document.getElementById("barcodeInput").value.trim();
  const inputType = document.querySelector(
    'input[name="inputType"]:checked'
  ).value;

  console.log(input);

  if (!input) {
    this.showStatus("Please enter a barcode or ID number", "error");
    this.focusInput();
    return;
  }

  // Check for duplicate scan
  if (this.isDuplicateScan(input)) {
    this.showStatus(
      "Duplicate scan detected - please wait before scanning again",
      "warning"
    );
    this.focusInput();
    return;
  }

  // Add to queue instead of processing immediately
  this.addToScanQueue(input, inputType);
}

addToScanQueue(input, inputType) {
  // Prevent queue overflow
  if (this.scanQueue.length >= this.maxQueueSize) {
    this.showStatus("Too many rapid scans - please wait", "warning");
    this.clearInput();
    return;
  }

  // Check if this input is already in the queue
  const alreadyInQueue = this.scanQueue.some(item => item.input === input);
  if (alreadyInQueue) {
    this.showStatus("Scan already in queue - please wait", "info");
    this.clearInput();
    return;
  }

  // Add to queue with timestamp
  this.scanQueue.push({
    input,
    inputType,
    timestamp: Date.now(),
    id: `scan-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  });

  // Update last scan data for duplicate prevention
  this.updateLastScanData(input);
  
  // Clear input immediately
  this.clearInput();

  // Show queue status
  this.showQueueStatus();

  // Start processing if not already processing
  if (!this.isProcessingScan) {
    this.processNextScan();
  }
}

async processNextScan() {
  if (this.isProcessingScan || this.scanQueue.length === 0) {
    return;
  }

  this.isProcessingScan = true;

  try {
    while (this.scanQueue.length > 0) {
      const scanData = this.scanQueue.shift(); // Remove from front of queue
      
      // Show which scan is being processed
      this.showStatus(
        `Processing scan ${this.scanQueue.length + 1} of ${this.scanQueue.length + 1}...`,
        "info"
      );

      await this.processSingleScan(scanData);
      
      // Small delay between scans to prevent overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) {
    console.error("Error processing scan queue:", error);
    this.showStatus("Error processing scans", "error");
  } finally {
    this.isProcessingScan = false;
    this.hideQueueStatus();
    this.focusInput();
  }
}

async processSingleScan(scanData) {
  const { input, inputType, timestamp } = scanData;
  
  // Check if scan is too old (optional - remove stale scans)
  const maxAge = 30000; // 30 seconds
  if (Date.now() - timestamp > maxAge) {
    console.log(`Skipping stale scan: ${input}`);
    return;
  }

  // Show loading screen for this specific scan
  this.showLoadingScreen();
  
  // Disable input during processing
  const barcodeInput = document.getElementById("barcodeInput");
  const submitButton = document.getElementById("manualSubmit");
  const originalText = submitButton.textContent;

  barcodeInput.disabled = true;
  submitButton.textContent = "Processing...";
  submitButton.disabled = true;

  try {
    console.log(`Processing scan: ${input} (type: ${inputType})`);
    
    const result = await this.electronAPI.clockAttendance({
      input: input,
      inputType: inputType,
    });

    if (result.success) {
      // Wait for loading screen (minimum 0.5 seconds)
      await new Promise((resolve) => setTimeout(resolve, 500));

      this.hideLoadingScreen();
      this.showEmployeeDisplay(result.data);
      await this.loadTodayAttendance();
      this.showStatus(
        `✅ Attendance recorded for ${result.data.employee.first_name} ${result.data.employee.last_name}`,
        "success"
      );

      // Mark summary data as changed
      this.markSummaryDataChanged();

      // Trigger automatic sync after successful attendance recording
      setTimeout(() => {
        this.performAttendanceSync(true); // Silent sync
      }, 3000);
      
    } else {
      // Wait for loading screen (minimum 2 seconds)
      await new Promise((resolve) => setTimeout(resolve, 2000));
      this.hideLoadingScreen();
      this.showStatus(
        `❌ ${result.error || "Employee not found"} (ID: ${input})`,
        "error"
      );
    }
  } catch (error) {
    console.error("Clock error:", error);
    // Wait for loading screen (minimum 2 seconds)
    await new Promise((resolve) => setTimeout(resolve, 2000));
    this.hideLoadingScreen();
    this.showStatus(`❌ System error for ID: ${input}`, "error");
  } finally {
    // Restore input and button
    barcodeInput.disabled = false;
    submitButton.textContent = originalText;
    submitButton.disabled = false;
  }
}

showQueueStatus() {
  let queueStatus = document.getElementById("queueStatus");
  
  if (!queueStatus) {
    queueStatus = document.createElement("div");
    queueStatus.id = "queueStatus";
    queueStatus.className = "queue-status";
    
    // Insert after the barcode input section
    const inputSection = document.querySelector(".barcode-section") || 
                         document.querySelector(".input-section") ||
                         document.getElementById("barcodeInput").parentElement;
    
    if (inputSection && inputSection.parentElement) {
      inputSection.parentElement.insertBefore(queueStatus, inputSection.nextSibling);
    } else {
      document.body.appendChild(queueStatus);
    }
  }

  if (this.scanQueue.length > 0) {
    queueStatus.innerHTML = `
      <div class="queue-indicator">
        📋 <strong>${this.scanQueue.length}</strong> scan${this.scanQueue.length !== 1 ? 's' : ''} in queue
        ${this.isProcessingScan ? '<span class="processing">⚡ Processing...</span>' : ''}
      </div>
    `;
    queueStatus.style.display = "block";
  } else {
    queueStatus.style.display = "none";
  }
}

hideQueueStatus() {
  const queueStatus = document.getElementById("queueStatus");
  if (queueStatus) {
    queueStatus.style.display = "none";
  }
}

 async setupImageWithFallback(imgElement, employee_uid, altText) {
  if (!imgElement || !employee_uid) return

  // Clear any existing error handlers
  imgElement.onerror = null
  imgElement.onload = null

  const attemptKey = `${employee_uid}_${imgElement.id}`

  // Clean up previous attempts for this element
  this.imageLoadAttempts.delete(attemptKey)
  this.imageLoadAttempts.set(attemptKey, 0)

  try {
    // Use your existing getLocalProfilePath method (this method EXISTS in your preload.js)
    if (this.electronAPI && this.electronAPI.getLocalProfilePath) {
      const result = await this.electronAPI.getLocalProfilePath(employee_uid)
      
      if (result.success && result.path) {
        // Convert Windows path to file URL for Electron
        const normalizedPath = result.path.replace(/\\/g, '/')
        const fileUrl = normalizedPath.startsWith('file:///') ? normalizedPath : `file:///${normalizedPath}`
        
        // Set up success handler
        imgElement.onload = () => {
          this.imageLoadAttempts.delete(attemptKey)
          imgElement.onerror = null
          imgElement.onload = null
          console.log(`Profile loaded successfully for UID ${employee_uid}`)
        }

        // Set up error handler to fall back to default
        imgElement.onerror = () => {
          console.log(`Profile image failed to load for UID ${employee_uid}, using default`)
          imgElement.src = this.getDefaultImageDataURL()
          imgElement.onerror = null
          imgElement.onload = null
          this.imageLoadAttempts.delete(attemptKey)
        }

        imgElement.alt = altText || "Profile Image"
        imgElement.src = fileUrl
        return
      }
    }

  } catch (error) {
    console.error(`Error getting profile path for UID ${employee_uid}:`, error)
  }

  // Fallback: use default image
  console.log(`No profile found for UID ${employee_uid}, using default image`)
  imgElement.src = this.getDefaultImageDataURL()
  imgElement.alt = altText || "Profile Image"
  imgElement.onerror = null
  imgElement.onload = null
  this.imageLoadAttempts.delete(attemptKey)
}

  // Generate a loading image as data URL
  getLoadingImageDataURL() {
    return "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgZmlsbD0iI2Y4ZjhmOCIgcng9IjUwIi8+PGNpcmNsZSBjeD0iNTAiIGN5PSI1MCIgcj0iMTUiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzAwN2NmZiIgc3Ryb2tlLXdpZHRoPSIzIiBzdHJva2UtZGFzaGFycmF5PSI4IDQiPjxhbmltYXRlVHJhbnNmb3JtIGF0dHJpYnV0ZU5hbWU9InRyYW5zZm9ybSIgYXR0cmlidXRlVHlwZT0iWE1MIiB0eXBlPSJyb3RhdGUiIGZyb209IjAgNTAgNTAiIHRvPSIzNjAgNTAgNTAiIGR1cj0iMXMiIHJlcGVhdENvdW50PSJpbmRlZmluaXRlIi8+PC9jaXJjbGU+PC9zdmc+";
  }

  showEmployeeDisplay(data) {
    const display = document.getElementById("employeeDisplay");
    const {
      employee,
      clockType,
      sessionType,
      clockTime,
      regularHours,
      overtimeHours,
      isOvertimeSession,
    } = data;

    // Update employee info
    document.getElementById("employeeName").textContent = `${
      employee.first_name
    } ${employee.middle_name || ""} ${employee.last_name}`.trim();
    document.getElementById("employeeDepartment").textContent =
      employee.department || "No Department";
    document.getElementById(
      "employeeId"
    ).textContent = `ID: ${employee.id_number}`;

const photo = document.getElementById("employeePhoto")
photo.style.display = "block"
this.setupImageWithFallback(photo, employee.uid, `${employee.first_name} ${employee.last_name}`)

    // Update clock info with enhanced display
    const clockTypeElement = document.getElementById("clockType");
    clockTypeElement.textContent = this.formatClockType(clockType, sessionType);
    clockTypeElement.className = `clock-type ${clockType.replace("_", "-")} ${
      isOvertimeSession ? "overtime" : ""
    }`;

    document.getElementById("clockTime").textContent = new Date(
      clockTime
    ).toLocaleTimeString();

    // Enhanced hours display
    const hoursInfo = document.getElementById("hoursInfo");
    const totalHours = (regularHours || 0) + (overtimeHours || 0);

    if (isOvertimeSession) {
      hoursInfo.innerHTML = `
        <div class="hours-breakdown overtime-session">
          <div class="regular-hours">Regular: ${regularHours || 0}h</div>
          <div class="overtime-hours">Overtime: ${overtimeHours || 0}h</div>
          <div class="total-hours">Total: ${totalHours.toFixed(2)}h</div>
          <div class="session-indicator">🌙 ${
            sessionType || "Overtime Session"
          }</div>
        </div>
      `;
    } else {
      hoursInfo.innerHTML = `
        <div class="hours-breakdown">
          <div class="regular-hours">Regular: ${regularHours || 0}h</div>
          <div class="overtime-hours">Overtime: ${overtimeHours.toFixed(
            2
          )}h</div>
          <div class="total-hours">Total: ${totalHours.toFixed(2)}h</div>
        </div>
      `;
    }

    // Show display
    display.style.display = "block";

    // Auto-hide after 10 seconds
    if (this.employeeDisplayTimeout) {
      clearTimeout(this.employeeDisplayTimeout);
    }

    this.employeeDisplayTimeout = setTimeout(() => {
      display.style.display = "none";
      this.focusInput();
    }, 10000);
  }

  formatClockType(clockType, sessionType) {
    // Use enhanced session type from backend if available
    if (sessionType) {
      const isIn = clockType.endsWith("_in");
      const emoji = isIn ? "🟢" : "🔴";
      const action = isIn ? "In" : "Out";
      return `${emoji} ${sessionType} ${action}`;
    }

    // Fallback to original mapping with new types
    const types = {
      morning_in: "🟢 Morning In",
      morning_out: "🔴 Morning Out",
      afternoon_in: "🟢 Afternoon In",
      afternoon_out: "🔴 Afternoon Out",
      evening_in: "🟢 Evening In (Overtime)",
      evening_out: "🔴 Evening Out (Overtime)",
      overtime_in: "🟢 Overtime In",
      overtime_out: "🔴 Overtime Out",
    };
    return types[clockType] || clockType;
  }

  clearInput() {
    document.getElementById("barcodeInput").value = "";
    setTimeout(() => this.focusInput(), 100);
  }

  async loadInitialData() {
  // Show download toast for initial data loading
  this.showDownloadToast("🔄 Loading initial data...", "info");

  try {
    // First, validate attendance data for accurate time calculations
    await this.validateAttendanceData();
    
    // Then load the regular data
    await Promise.all([this.loadTodayAttendance(), this.syncEmployees()]);
    
    this.showDownloadToast("✅ Initial data loaded successfully!", "success");
  } catch (error) {
    console.error("Error loading initial data:", error);
    this.showDownloadToast("❌ Failed to load initial data", "error");
  }
}

// New method to validate attendance data
async validateAttendanceData() {
  if (!this.electronAPI) {
    console.log("Demo mode: Skipping attendance validation");
    return { success: true, message: "Demo mode - validation skipped" };
  }

  try {
    this.showDownloadToast("🔍 Validating attendance calculations...", "info");
    
    // Validate today's attendance data
    const today = new Date().toISOString().split('T')[0];
    
    // Get validation result from the main process
    const validationResult = await this.electronAPI.validateAttendanceData({
      startDate: today,
      endDate: today,
      autoCorrect: true,
      updateSyncStatus: true,
      validateStatistics: true,
      rebuildSummary: false
    });

    if (validationResult.success && validationResult.data) {
      // The data structure from AttendanceValidationService.validationResults
      const validationData = validationResult.data;
      
      // Check if we have the expected structure
      if (validationData.totalRecords !== undefined) {
        const correctedRecords = validationData.correctedRecords || 0;
        const totalRecords = validationData.totalRecords || 0;
        
        if (correctedRecords > 0) {
          console.log(`Validation completed: ${correctedRecords} records corrected out of ${totalRecords} total`);
          this.showDownloadToast(
            `✅ Validated ${totalRecords} records (${correctedRecords} corrections)`,
            "success"
          );
          
          // Mark summary data as changed if corrections were made
          this.markSummaryDataChanged();
          
          // Trigger a sync for corrected data after a delay
          setTimeout(() => {
            this.performAttendanceSync(true); // Silent sync
          }, 5000);
        } else {
          console.log(`Validation completed: All ${totalRecords} records are accurate`);
          this.showDownloadToast(
            `✅ All ${totalRecords} attendance records validated`,
            "success"
          );
        }
      } else {
        // Fallback if structure is different
        console.log("Validation completed with unknown result structure:", validationData);
        this.showDownloadToast("✅ Attendance validation completed", "success");
      }
      
      return validationResult;
    } else {
      const errorMessage = validationResult.error || "Unknown validation error";
      console.warn("Attendance validation failed:", errorMessage);
      this.showDownloadToast("⚠️ Attendance validation encountered issues", "warning");
      return validationResult;
    }
    
  } catch (error) {
    console.error("Error during attendance validation:", error);
    this.showDownloadToast("❌ Attendance validation failed", "error");
    
    // Don't throw the error - continue with loading even if validation fails
    return { success: false, error: error.message };
  }
}

  async loadTodayAttendance() {
    try {
      const result = await this.electronAPI.getTodayAttendance();

      if (result.success) {
        this.updateCurrentlyClocked(result.data.currentlyClocked);
        this.updateTodayActivity(result.data.attendance);
        this.updateStatistics(result.data.statistics);
        this.loadDailySummary();
      }
    } catch (error) {
      console.error("Error loading attendance:", error);
    }
  }

  initializeDateRangeControls() {
    // Set default end date to today
    const today = new Date().toISOString().split("T")[0];
    document.getElementById("endDate").value = today;

    // Set default start date to 7 days ago
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    document.getElementById("startDate").value = weekAgo
      .toISOString()
      .split("T")[0];

    // Add event listeners
    document
      .getElementById("applyDateFilter")
      .addEventListener("click", () => this.applyDateFilter());
    document
      .getElementById("clearDateFilter")
      .addEventListener("click", () => this.clearDateFilter());

    // Quick date range buttons
    document.querySelectorAll("[data-range]").forEach((btn) => {
      btn.addEventListener("click", (e) =>
        this.setQuickDateRange(e.target.dataset.range)
      );
    });

    // Auto-apply filter when dates change
    document
      .getElementById("startDate")
      .addEventListener("change", () => this.applyDateFilter());
    document
      .getElementById("endDate")
      .addEventListener("change", () => this.applyDateFilter());
  }

  setQuickDateRange(range) {
    const today = new Date();
    const startDateInput = document.getElementById("startDate");
    const endDateInput = document.getElementById("endDate");

    let startDate,
      endDate = new Date(today);

    switch (range) {
      case "today":
        startDate = new Date(today);
        break;
      case "yesterday":
        startDate = new Date(today);
        startDate.setDate(today.getDate() - 1);
        endDate = new Date(startDate);
        break;
      case "week":
        startDate = new Date(today);
        startDate.setDate(today.getDate() - today.getDay()); // Start of week (Sunday)
        break;
      case "month":
        startDate = new Date(today.getFullYear(), today.getMonth(), 1);
        break;
      case "last7":
        startDate = new Date(today);
        startDate.setDate(today.getDate() - 6); // Include today
        break;
      case "last30":
        startDate = new Date(today);
        startDate.setDate(today.getDate() - 29); // Include today
        break;
      default:
        return;
    }

    startDateInput.value = startDate.toISOString().split("T")[0];
    endDateInput.value = endDate.toISOString().split("T")[0];

    this.applyDateFilter();
  }

  applyDateFilter() {
    const startDate = document.getElementById("startDate").value;
    const endDate = document.getElementById("endDate").value;

    // Validation
    if (startDate && endDate && startDate > endDate) {
      this.showStatus("Start date cannot be after end date", "error");
      return;
    }

    this.currentDateRange.startDate = startDate || null;
    this.currentDateRange.endDate = endDate || null;

    this.loadDailySummary();
  }

  clearDateFilter() {
    document.getElementById("startDate").value = "";
    document.getElementById("endDate").value = "";
    this.currentDateRange.startDate = null;
    this.currentDateRange.endDate = null;

    this.loadDailySummary();
  }

  async loadDailySummary() {
    try {
      const result = await this.electronAPI.getDailySummary(
        this.currentDateRange.startDate,
        this.currentDateRange.endDate
      );

      if (result.success) {
        this.summaryData = result.data;
        this.updateDailySummaryTable(result.data);
        this.updateSummaryStats(result.data);
      } else {
        console.error("Failed to load daily summary:", result.error);
        this.showStatus("Failed to load daily summary", "error");
      }
    } catch (error) {
      console.error("Error loading daily summary:", error);
      const tbody = document.getElementById("summaryTableBody");
      if (tbody) {
        tbody.innerHTML =
          '<tr><td colspan="20" class="loading">Error loading summary</td></tr>';
      }
    }
  }

  updateSummaryStats(summaryData) {
    const totalRecordsEl = document.getElementById("totalRecords");
    const dateRangeTextEl = document.getElementById("dateRangeText");
    const totalHoursEl = document.getElementById("totalHours");

    // Update total records
    if (totalRecordsEl) {
      totalRecordsEl.textContent = summaryData.length.toLocaleString();
    }

    // Update date range text
    if (dateRangeTextEl) {
      let rangeText = "All Records";
      if (this.currentDateRange.startDate || this.currentDateRange.endDate) {
        const start = this.currentDateRange.startDate
          ? new Date(this.currentDateRange.startDate).toLocaleDateString()
          : "Beginning";
        const end = this.currentDateRange.endDate
          ? new Date(this.currentDateRange.endDate).toLocaleDateString()
          : "Latest";
        rangeText = `${start} - ${end}`;
      }
      dateRangeTextEl.textContent = rangeText;
    }

    // Calculate and update total hours
    if (totalHoursEl) {
      const totalHours = summaryData.reduce((sum, record) => {
        return sum + (parseFloat(record.total_hours) || 0);
      }, 0);
      totalHoursEl.textContent = totalHours.toFixed(1) + " hrs";
    }
  }

  updateDailySummaryTable(summaryData) {
    const tbody = document.getElementById("summaryTableBody");

    if (!summaryData || summaryData.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="20" class="loading">No summary data available for the selected date range</td></tr>';
      return;
    }

    tbody.innerHTML = summaryData
      .map((record) => {
        const status = this.getEmployeeStatus(record);

        return `
        <tr>
          <td>${record.employee_name || "Unknown"}</td>
          <td>${record.first_name || ""}</td>
          <td>${record.last_name || ""}</td>
          <td>${record.department || "N/A"}</td>
          <td>${record.id_number || "N/A"}</td>
          <td>${record.date || ""}</td>
          <td>${this.formatDateTime(record.first_clock_in)}</td>
          <td>${this.formatDateTime(record.last_clock_out)}</td>
          <td>${this.formatDateTime(record.morning_in)}</td>
          <td>${this.formatDateTime(record.morning_out)}</td>
          <td>${this.formatDateTime(record.afternoon_in)}</td>
          <td>${this.formatDateTime(record.afternoon_out)}</td>
          <td>${this.formatDateTime(record.evening_in)}</td>
          <td>${this.formatDateTime(record.evening_out)}</td>
          <td>${this.formatDateTime(record.overtime_in)}</td>
          <td>${this.formatDateTime(record.overtime_out)}</td>
          <td>${(record.regular_hours || 0).toFixed(2)}</td>
          <td>${(record.overtime_hours || 0).toFixed(2)}</td>
          <td>${(record.total_hours || 0).toFixed(2)}</td>
          <td><span class="status-badge ${status.class}">${
          status.text
        }</span></td>
        </tr>
      `;
      })
      .join("");
  }

  formatDateTime(dateTimeString) {
    if (!dateTimeString) return "-";

    try {
      const date = new Date(dateTimeString);
      return (
        date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        }) +
        " - " +
        date.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        })
      );
    } catch (error) {
      return "-";
    }
  }

  getEmployeeStatus(record) {
    if (record.has_overtime) {
      return { class: "overtime", text: "Overtime" };
    } else if (record.is_incomplete) {
      return { class: "incomplete", text: "Incomplete" };
    } else {
      return { class: "complete", text: "Complete" };
    }
  }

  async downloadExcel() {
    try {
      // Use the current filtered data instead of fetching again
      const summaryData = this.summaryData;

      if (!summaryData || summaryData.length === 0) {
        this.showStatus("No data available for export", "error");
        return;
      }

      const excelData = summaryData.map((record) => ({
        "Employee Name": record.employee_name || "Unknown",
        "First Name": record.first_name || "",
        "Last Name": record.last_name || "",
        Department: record.department || "N/A",
        "ID Number": record.id_number || "N/A",
        "ID Barcode": record.id_barcode || "N/A",
        Date: record.date,
        "First Clock In": this.formatDateTime(record.first_clock_in),
        "Last Clock Out": this.formatDateTime(record.last_clock_out),
        "Morning In": this.formatDateTime(record.morning_in),
        "Morning Out": this.formatDateTime(record.morning_out),
        "Afternoon In": this.formatDateTime(record.afternoon_in),
        "Afternoon Out": this.formatDateTime(record.afternoon_out),
        "Evening In": this.formatDateTime(record.evening_in),
        "Evening Out": this.formatDateTime(record.evening_out),
        "Overtime In": this.formatDateTime(record.overtime_in),
        "Overtime Out": this.formatDateTime(record.overtime_out),
        "Regular Hours": (record.regular_hours || 0).toFixed(2),
        "Overtime Hours": (record.overtime_hours || 0).toFixed(2),
        "Total Hours": (record.total_hours || 0).toFixed(2),
        "Morning Hours": (record.morning_hours || 0).toFixed(2),
        "Afternoon Hours": (record.afternoon_hours || 0).toFixed(2),
        "Evening Hours": (record.evening_hours || 0).toFixed(2),
        "Overtime Session Hours": (record.overtime_session_hours || 0).toFixed(
          2
        ),
        "Is Incomplete": record.is_incomplete ? "Yes" : "No",
        "Has Late Entry": record.has_late_entry ? "Yes" : "No",
        "Has Overtime": record.has_overtime ? "Yes" : "No",
        "Has Evening Session": record.has_evening_session ? "Yes" : "No",
        "Total Sessions": record.total_sessions || 0,
        "Completed Sessions": record.completed_sessions || 0,
        "Pending Sessions": record.pending_sessions || 0,
        "Total Minutes Worked": record.total_minutes_worked || 0,
        "Break Time Minutes": record.break_time_minutes || 0,
        Status: this.getEmployeeStatus(record).text,
      }));

      // Create Excel file using SheetJS
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(excelData);

      // Auto-size columns
      const colWidths = Object.keys(excelData[0] || {}).map((key) => ({
        wch: Math.max(key.length, 15),
      }));
      ws["!cols"] = colWidths;

      XLSX.utils.book_append_sheet(wb, ws, "Daily Attendance Summary");

      // Generate filename with date range
      let filename = "Daily_Attendance_Summary";

      if (this.currentDateRange.startDate || this.currentDateRange.endDate) {
        const start = this.currentDateRange.startDate || "all";
        const end = this.currentDateRange.endDate || "latest";
        filename += `_${start}_to_${end}`;
      } else {
        const today = new Date().toISOString().split("T")[0];
        filename += `_${today}`;
      }

      filename += ".xlsx";

      // Download file
      XLSX.writeFile(wb, filename);

      // Show success message with record count
      const recordCount = summaryData.length;
      const dateRangeText =
        this.currentDateRange.startDate || this.currentDateRange.endDate
          ? `for selected date range`
          : `for all dates`;

      this.showStatus(
        `Excel file downloaded successfully! ${recordCount} records exported ${dateRangeText}`,
        "success"
      );
    } catch (error) {
      console.error("Error downloading Excel:", error);
      this.showStatus("Error downloading Excel file", "error");
    }
  }

  showStatus(message, type) {
    const statusEl = document.getElementById("settingsStatusMessage");
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = `status-message ${type}`;
      statusEl.style.display = "block";

      setTimeout(() => {
        statusEl.style.display = "none";
      }, 5000);
    }
  }

  updateStatistics(stats) {
    if (!stats) return;

    // Update basic statistics
    document.getElementById("totalRegularHours").textContent =
      stats.totalRegularHours || 0;
    document.getElementById("totalOvertimeHours").textContent =
      stats.totalOvertimeHours || 0;
    document.getElementById("presentCount").textContent =
      stats.presentCount || 0;
    document.getElementById("lateCount").textContent = stats.lateCount || 0;
    document.getElementById("absentCount").textContent = stats.absentCount || 0;

    // Update overtime-specific statistics if available
    if (stats.overtimeEmployeesCount !== undefined) {
      const overtimeStatsElement = document.getElementById("overtimeStats");
      if (overtimeStatsElement) {
        overtimeStatsElement.innerHTML = `
          <div class="stat-item overtime-stat">
            <div class="stat-value">${stats.overtimeEmployeesCount}</div>
            <div class="stat-label">In Overtime</div>
          </div>
          <div class="stat-item evening-stat">
            <div class="stat-value">${stats.eveningSessionsCount || 0}</div>
            <div class="stat-label">Evening Sessions</div>
          </div>
        `;
      }
    }

    // Update session breakdown if available
    if (stats.sessionBreakdown) {
      const sessionBreakdownElement =
        document.getElementById("sessionBreakdown");
      if (sessionBreakdownElement) {
        sessionBreakdownElement.innerHTML = `
          <div class="session-stat morning">
            <span class="session-count">${
              stats.sessionBreakdown.morning || 0
            }</span>
            <span class="session-label">Morning</span>
          </div>
          <div class="session-stat afternoon">
            <span class="session-count">${
              stats.sessionBreakdown.afternoon || 0
            }</span>
            <span class="session-label">Afternoon</span>
          </div>
          <div class="session-stat evening">
            <span class="session-count">${
              stats.sessionBreakdown.evening || 0
            }</span>
            <span class="session-label">Evening</span>
          </div>
          <div class="session-stat overtime">
            <span class="session-count">${
              stats.sessionBreakdown.overtime || 0
            }</span>
            <span class="session-label">Overtime</span>
          </div>
        `;
      }
    }
  }

  updateCurrentlyClocked(employees) {
    const container = document.getElementById("currentlyClocked");

    if (!employees || employees.length === 0) {
      container.innerHTML =
        '<div class="loading">No employees currently clocked in</div>';
      return;
    }

    const imageIds = [];

    container.innerHTML = employees
      .map((emp) => {
        const empId = this.generateUniqueId(`clocked-${emp.employee_uid}`);
        imageIds.push({
          id: empId,
          uid: emp.employee_uid,
          name: `${emp.first_name} ${emp.last_name}`,
        });

        // Determine session type and styling
        const sessionType =
          emp.sessionType ||
          this.getSessionTypeFromClockType(emp.last_clock_type);
        const isOvertime =
          emp.isOvertimeSession ||
          this.isOvertimeClockType(emp.last_clock_type);
        const badgeClass = isOvertime ? "overtime" : "in";
        const sessionIcon = this.getSessionIcon(emp.last_clock_type);

        return `
            <div class="employee-item ${isOvertime ? "overtime-employee" : ""}">
                <img class="employee-avatar" 
                     id="${empId}"
                     alt="${emp.first_name} ${emp.last_name}">
                <div class="employee-details">
                    <div class="employee-name">${emp.first_name} ${
          emp.last_name
        }</div>
                    <div class="employee-dept">${
                      emp.department || "No Department"
                    }</div>
                </div>
                <div class="clock-badge ${badgeClass}">
                    ${sessionIcon} ${sessionType}
                </div>
            </div>
        `;
      })
      .join("");

setTimeout(() => {
  imageIds.forEach(({ id, uid, name }) => {
    const imgElement = document.getElementById(id)
    if (imgElement) {
      this.setupImageWithFallback(imgElement, uid, name)
    }
  })
}, 10)
  }

  updateTodayActivity(attendance) {
    const container = document.getElementById("todayActivity");

    if (!attendance || attendance.length === 0) {
      container.innerHTML = '<div class="loading">No activity today</div>';
      return;
    }

    const attendanceSlice = attendance.slice(0, 10);
    const imageIds = [];

    container.innerHTML = attendanceSlice
      .map((record, index) => {
        const recordId = this.generateUniqueId(
          `activity-${record.employee_uid}-${index}`
        );
        imageIds.push({
          id: recordId,
          uid: record.employee_uid,
          name: `${record.first_name} ${record.last_name}`,
        });

        // Enhanced display for overtime sessions
        const sessionType =
          record.sessionType ||
          this.getSessionTypeFromClockType(record.clock_type);
        const isOvertime =
          record.isOvertimeSession ||
          this.isOvertimeClockType(record.clock_type);
        const badgeClass = record.clock_type.includes("in") ? "in" : "out";
        const finalBadgeClass = `${badgeClass} ${isOvertime ? "overtime" : ""}`;

        return `
            <div class="attendance-item ${isOvertime ? "overtime-record" : ""}">
                <img class="attendance-avatar" 
                     id="${recordId}"
                     alt="${record.first_name} ${record.last_name}">
                <div class="attendance-details">
                    <div class="attendance-name">${record.first_name} ${
          record.last_name
        }</div>
                    <div class="attendance-time">${new Date(
                      record.clock_time
                    ).toLocaleTimeString()}</div>
                    ${
                      isOvertime
                        ? '<div class="overtime-indicator">Overtime Session</div>'
                        : ""
                    }
                </div>
                <div class="clock-badge ${finalBadgeClass}">
                    ${this.formatClockType(record.clock_type, sessionType)}
                </div>
            </div>
        `;
      })
      .join("");

setTimeout(() => {
  imageIds.forEach(({ id, uid, name }) => {
    const imgElement = document.getElementById(id)
    if (imgElement) {
      this.setupImageWithFallback(imgElement, uid, name)
    }
  })
}, 10)
  }

  // Helper function to determine if clock type is overtime
  isOvertimeClockType(clockType) {
    return (
      clockType &&
      (clockType.startsWith("evening") || clockType.startsWith("overtime"))
    );
  }

  // Helper function to get session type from clock type
  getSessionTypeFromClockType(clockType) {
    if (!clockType) return "Unknown";

    if (clockType.startsWith("morning")) return "Morning";
    if (clockType.startsWith("afternoon")) return "Afternoon";
    if (clockType.startsWith("evening")) return "Evening";
    if (clockType.startsWith("overtime")) return "Overtime";

    return "Unknown";
  }

  // Helper function to get session icon
  getSessionIcon(clockType) {
    if (!clockType) return "🔘";

    if (clockType.startsWith("morning")) return "🌅";
    if (clockType.startsWith("afternoon")) return "☀️";
    if (clockType.startsWith("evening")) return "🌙";
    if (clockType.startsWith("overtime")) return "⭐";

    return "🔘";
  }

  showStatus(message, type = "info") {
    const statusElement = document.getElementById("statusMessage");
    statusElement.textContent = message;
    statusElement.className = `status-message ${type} show`;

    setTimeout(() => {
      statusElement.classList.remove("show");
    }, 4000);
  }

  destroy() {
  this.stopAutoSync();

  // Clear scan queue
  this.scanQueue = [];
  this.isProcessingScan = false;

  if (this.employeeDisplayTimeout) {
    clearTimeout(this.employeeDisplayTimeout);
  }

  if (this.barcodeTimeout) {
    clearTimeout(this.barcodeTimeout);
  }

  if (this.ws) {
    this.ws.close();
  }

  // Clean up image load attempts
  this.imageLoadAttempts.clear();

  // Clean up download toast
  const downloadToast = document.getElementById("downloadToast");
  if (downloadToast && downloadToast.hideTimeout) {
    clearTimeout(downloadToast.hideTimeout);
  }

  // Clean up queue status
  const queueStatus = document.getElementById("queueStatus");
  if (queueStatus) {
    queueStatus.remove();
  }

  console.log("AttendanceApp destroyed and cleaned up");
}
}

// Initialize app when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  // Store reference globally for cleanup if needed
  window.attendanceApp = new AttendanceApp();
});

// Clean up on page unload
window.addEventListener("beforeunload", () => {
  if (
    window.attendanceApp &&
    typeof window.attendanceApp.destroy === "function"
  ) {
    window.attendanceApp.destroy();
  }
});
