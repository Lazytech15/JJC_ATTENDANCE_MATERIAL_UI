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

    // PERFORMANCE: Add cache-related properties
    this.profileCache = new Map(); // Renderer-side cache
    this.imageCache = new Map(); // Renderer-side image cache
    this.preloadedProfiles = new Set(); // Track preloaded profiles
    this.lastCacheStats = null;
    this.cacheStatsInterval = null;

    this.setupImageWithFallback = this.setupImageWithFallback.bind(this);
    this.tryFileSystemImage = this.tryFileSystemImage.bind(this);
    this.getDefaultImageDataURL = this.getDefaultImageDataURL.bind(this);
    this.initializePerformanceCaches =
      this.initializePerformanceCaches.bind(this);
    this.preloadAllProfilesAndImages =
      this.preloadAllProfilesAndImages.bind(this);

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
    this.faceRecognitionManager = null;

    // Server edit sync tracking - MANUAL ONLY
    this.lastServerEditCheck = null;

    // Initialize server edit sync listener
    this.setupServerEditSyncListener();

    this.barcodeTimeout = null; // Add timeout for barcode handling
    this.autoSyncInterval = null; // Auto-sync interval
    this.summaryAutoSyncInterval = null; // Summary auto-sync interval

    this.faceRecognitionSchedule = [
      { hour: 8, minute: 0, second: 0 },   // 07:59:20
      { hour: 12, minute: 0, second: 0 },   // 11:59:00 (12:00)
      { hour: 13, minute: 0, second: 0 },   // 12:59:00 (13:00)
      { hour: 17, minute: 0, second: 0 }    // 16:59:00 (17:00)
    ];
    this.faceRecognitionDuration = 15; // Minutes to keep open
    this.faceRecognitionCheckInterval = null;
    this.faceRecognitionAutoCloseTimeout = null;
    // END NEW LINES

    // PERFORMANCE: Add cache-related properties
    this.profileCache = new Map();

    this.barcodeTimeout = null; // Add timeout for barcode handling
    this.autoSyncInterval = null; // Auto-sync interval
    this.summaryAutoSyncInterval = null; // Summary auto-sync interval

    // SCHEDULED SYNC: Define sync schedule (military time)
    this.attendanceSyncSchedule = [
      { hour: 8, minute: 30, second: 0 },   // 08:30:00 AM
      { hour: 12, minute: 30, second: 0 },  // 12:30:00 PM
      { hour: 13, minute: 30, second: 0 },  // 01:30:00 PM
      { hour: 17, minute: 30, second: 0 }   // 05:30:00 PM
    ];
    this.scheduledSyncCheckInterval = null;
    this.lastScheduledSyncTime = null;
    this.pendingAttendanceSync = false; // Track if sync is needed

    // Face recognition schedule
    this.faceRecognitionSchedule = [
      { hour: 8, minute: 0, second: 0 },   // 08:00:00 AM
      { hour: 12, minute: 0, second: 0 },  // 12:00:00 PM
      { hour: 13, minute: 0, second: 0 },  // 01:00:00 PM
      { hour: 17, minute: 0, second: 0 }   // 05:00:00 PM
    ];
    this.faceRecognitionDuration = 5; // Minutes to keep open
    this.faceRecognitionCheckInterval = null;
    this.faceRecognitionAutoCloseTimeout = null;
    // END NEW LINES

    // PERFORMANCE: Add cache-related properties
    this.profileCache = new Map();
  }

  // SCHEDULED SYNC: Start scheduled attendance sync
  startScheduledAttendanceSync() {
    console.log('Starting scheduled attendance sync...');
    console.log('Sync schedule:', this.attendanceSyncSchedule.map(s =>
      `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}:${String(s.second).padStart(2, '0')}`
    ).join(', '));

    // Check every second for scheduled sync times
    this.scheduledSyncCheckInterval = setInterval(() => {
      this.checkScheduledSyncTime();
    }, 1000);

    // Also check immediately after 2 seconds
    setTimeout(() => this.checkScheduledSyncTime(), 2000);
  }

  // SCHEDULED SYNC: Check if current time matches sync schedule
  checkScheduledSyncTime() {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentSecond = now.getSeconds();

    const matchedSchedule = this.attendanceSyncSchedule.find(
      schedule => schedule.hour === currentHour &&
        schedule.minute === currentMinute &&
        schedule.second === currentSecond
    );

    if (matchedSchedule) {
      const timeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}:${String(currentSecond).padStart(2, '0')}`;
      console.log(`⏰ Scheduled sync triggered at ${timeStr}`);

      // Prevent duplicate syncs within the same minute
      const lastSyncKey = `${currentHour}-${currentMinute}`;
      if (this.lastScheduledSyncTime !== lastSyncKey) {
        this.lastScheduledSyncTime = lastSyncKey;
        this.performScheduledSync();
      }
    }
  }

  // SCHEDULED SYNC: Perform the actual sync
  async performScheduledSync() {
    try {
      console.log('🔄 Executing scheduled sync (Attendance + Summary)...');

      // STEP 1: Sync Attendance
      const attendanceCount = await this.electronAPI.getUnsyncedAttendanceCount();

      let attendanceSynced = 0;
      let summarySynced = 0;

      if (attendanceCount && attendanceCount.success && attendanceCount.count > 0) {
        this.showDownloadToast(
          `⏰ Scheduled Sync: Uploading ${attendanceCount.count} attendance records...`,
          'info'
        );

        const attendanceSync = await this.performAttendanceSync(false, 0, true);

        if (attendanceSync && attendanceSync.success) {
          this.pendingAttendanceSync = false;
          attendanceSynced = attendanceCount.count;
          console.log(`✓ Attendance sync: ${attendanceSynced} records uploaded`);
        } else {
          console.error('✗ Attendance sync failed:', attendanceSync?.error || 'Unknown error');
        }
      } else {
        console.log('✓ No attendance records to sync');
      }

      // STEP 2: Sync Summary (wait a moment for attendance to process)
      await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay

      const summaryCount = await this.electronAPI.getUnsyncedDailySummaryCount();

      if (summaryCount && summaryCount.success && summaryCount.count > 0) {
        this.showDownloadToast(
          `⏰ Scheduled Sync: Uploading ${summaryCount.count} summary records...`,
          'info'
        );

        const summarySync = await this.performSummarySync(false, 0, true);

        if (summarySync && summarySync.success) {
          this.pendingSummarySync = false;
          summarySynced = summaryCount.count;
          console.log(`✓ Summary sync: ${summarySynced} records uploaded`);
        } else {
          console.error('✗ Summary sync failed:', summarySync?.error || 'Unknown error');
        }
      } else {
        console.log('✓ No summary records to sync');
      }

      // STEP 3: Final success message
      const totalRecords = attendanceSynced + summarySynced;

      if (totalRecords > 0) {
        this.showDownloadToast(
          `✅ Scheduled Sync Complete!\n` +
          `Attendance: ${attendanceSynced} | Summary: ${summarySynced}`,
          'success'
        );
      }

    } catch (error) {
      console.error('Scheduled sync error:', error);
      this.showDownloadToast(
        `❌ Scheduled Sync Error: ${error.message}`,
        'error'
      );
    }
  }

  // SCHEDULED SYNC: Stop scheduled sync
  stopScheduledSync() {
    if (this.scheduledSyncCheckInterval) {
      clearInterval(this.scheduledSyncCheckInterval);
      this.scheduledSyncCheckInterval = null;
      console.log('Scheduled attendance sync stopped');
    }
  }

  // SCHEDULED SYNC: Mark that attendance data needs syncing
  markAttendanceForSync() {
    this.pendingAttendanceSync = true;
    console.log('📌 Attendance marked for next scheduled sync');
  }

  // Helper method to wait for face-api.js
  waitForFaceApi(timeout = 15000) {
    return new Promise((resolve) => {
      // Check if already loaded
      if (typeof faceapi !== 'undefined') {
        console.log('face-api.js already loaded');
        resolve(true);
        return;
      }

      const startTime = Date.now();
      let attempts = 0;

      const checkInterval = setInterval(() => {
        attempts++;

        if (typeof faceapi !== 'undefined') {
          clearInterval(checkInterval);
          console.log(`face-api.js loaded after ${attempts} attempts`);
          resolve(true);
        } else if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval);
          console.warn(`Timeout waiting for face-api.js after ${attempts} attempts`);
          resolve(false);
        } else if (attempts % 10 === 0) {
          console.log(`Still waiting for face-api.js... (attempt ${attempts})`);
        }
      }, 100);
    });
  }

  /**
   * Update init() method to include server edit sync
   */
  async init() {
    this.setupEventListeners();
    this.startClock();
    this.connectWebSocket();

    // PERFORMANCE: Initialize caches and preload data FIRST
    await this.initializePerformanceCaches();
    await this.loadInitialData();

    await this.loadSyncSettings();
    this.startScheduledAttendanceSync();
    this.startAutoSync();
    // this.startSummaryAutoSync();

    this.focusInput();
    this.startCacheMonitoring();

    // Face recognition initialization
    if (typeof FaceRecognitionManager !== 'undefined') {
      this.faceRecognitionManager = new FaceRecognitionManager(this);
      console.log('Face recognition manager created (lazy init)');
      this.startFaceRecognitionScheduler();
    } else {
      console.warn('FaceRecognitionManager not available');
    }
  }

  // Add this new method for when user updates a profile image
  async onProfileImageUpdated(employeeUID) {
    if (this.faceRecognitionManager) {
      // Force regenerate descriptor for this employee
      await this.faceRecognitionManager.refreshSingleDescriptor(employeeUID, true);
      console.log(`Face descriptor refreshed for employee ${employeeUID}`);
    }
  }

  startFaceRecognitionScheduler() {
    console.log('Starting face recognition scheduler...');
    // Check every second instead of every minute
    this.faceRecognitionCheckInterval = setInterval(() => {
      this.checkFaceRecognitionSchedule();
    }, 1000);  // Changed from 60000 to 1000 (1 second)
    setTimeout(() => this.checkFaceRecognitionSchedule(), 2000);
  }

  checkFaceRecognitionSchedule() {
    if (!this.faceRecognitionManager) return;

    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentSecond = now.getSeconds();  // ADD THIS LINE

    const matchedSchedule = this.faceRecognitionSchedule.find(
      schedule => schedule.hour === currentHour &&
        schedule.minute === currentMinute &&
        schedule.second === currentSecond  // ADD THIS CONDITION
    );

    if (matchedSchedule) {
      console.log(`Face recognition auto-start at ${currentHour}:${String(currentMinute).padStart(2, '0')}:${String(currentSecond).padStart(2, '0')}`);
      this.autoOpenFaceRecognition();
    }
  }

  async autoOpenFaceRecognition() {
    if (!this.faceRecognitionManager) return;

    // Check if face recognition is enabled in settings
    try {
      const settingsResult = await this.electronAPI.getSettings();
      if (settingsResult.success) {
        const faceRecognitionEnabled = settingsResult.data.face_detection_enabled === "true" ||
          settingsResult.data.face_detection_enabled === true;

        if (!faceRecognitionEnabled) {
          console.log('Face recognition is disabled in settings - skipping auto-open');
          return;
        }
      }
    } catch (error) {
      console.warn('Could not check face recognition settings:', error);
      // If we can't check settings, don't auto-open (fail safe)
      return;
    }

    try {
      console.log('Auto-opening face recognition...');

      // Clear any existing auto-close mechanisms first
      if (this.faceRecognitionAutoCloseTimeout) {
        clearTimeout(this.faceRecognitionAutoCloseTimeout);
        this.faceRecognitionAutoCloseTimeout = null;
        console.log('Cleared existing auto-close timeout');
      }
      if (this.faceRecognitionAutoCloseInterval) {
        clearInterval(this.faceRecognitionAutoCloseInterval);
        this.faceRecognitionAutoCloseInterval = null;
        console.log('Cleared existing auto-close interval');
      }

      // Show the modal first
      await this.faceRecognitionManager.show();

      // Wait a moment for UI to render
      await new Promise(resolve => setTimeout(resolve, 500));

      // Ensure models are loaded and initialized
      if (!this.faceRecognitionManager.modelsLoaded) {
        console.log('Waiting for models to load...');
        await this.faceRecognitionManager.init();
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Ensure descriptors are loaded
      if (!this.faceRecognitionManager.descriptorsLoaded) {
        console.log('Waiting for descriptors to load...');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Now start recognition
      if (!this.faceRecognitionManager.isActive) {
        console.log('Starting recognition automatically...');
        await this.faceRecognitionManager.startRecognition();
      }

      // Calculate the target close time based on actual system clock
      const durationMs = this.faceRecognitionDuration * 60 * 1000;
      this.faceRecognitionAutoCloseTime = Date.now() + durationMs;

      console.log(`Setting auto-close for ${this.faceRecognitionDuration} minutes (${durationMs}ms)`);
      console.log(`Target close time: ${new Date(this.faceRecognitionAutoCloseTime).toLocaleTimeString()}`);

      // Show countdown timer
      this.faceRecognitionManager.showCountdownTimer(this.faceRecognitionAutoCloseTime);

      // Use interval-based checking that respects system clock
      // Check every 1 second for countdown updates
      this.faceRecognitionAutoCloseInterval = setInterval(() => {
        const now = Date.now();

        // Check if modal is still visible
        const container = document.getElementById('faceRecognitionContainer');
        if (!container || container.classList.contains('hidden')) {
          console.log('Face recognition closed manually, clearing auto-close');
          clearInterval(this.faceRecognitionAutoCloseInterval);
          this.faceRecognitionAutoCloseInterval = null;
          if (this.faceRecognitionManager) {
            this.faceRecognitionManager.hideCountdownTimer();
          }
          return;
        }

        const remaining = Math.floor((this.faceRecognitionAutoCloseTime - now) / 1000);

        // Update countdown display
        if (this.faceRecognitionManager) {
          this.faceRecognitionManager.updateCountdown(remaining);
        }

        if (remaining <= 0) {
          console.log('Auto-close time reached! Closing face recognition...');
          clearInterval(this.faceRecognitionAutoCloseInterval);
          this.faceRecognitionAutoCloseInterval = null;
          this.autoCloseFaceRecognition();
        }
      }, 1000); // Check every 1 second for smooth countdown

      this.showDownloadToast(
        `🎥 Face Recognition Auto-Started (closes in ${this.faceRecognitionDuration} min)`,
        'info'
      );

      console.log(`✓ Auto-close scheduled at ${new Date(this.faceRecognitionAutoCloseTime).toLocaleTimeString()}`);
    } catch (error) {
      console.error('Error auto-opening face recognition:', error);
    }
  }

  autoCloseFaceRecognition() {
    if (!this.faceRecognitionManager) return;

    try {
      if (this.faceRecognitionManager.isActive) {
        this.faceRecognitionManager.stopRecognition();
      }
      this.faceRecognitionManager.hide();
      this.showDownloadToast('🎥 Face Recognition Auto-Closed', 'info');
    } catch (error) {
      console.error('Error auto-closing face recognition:', error);
    }
  }

  stopFaceRecognitionScheduler() {
    if (this.faceRecognitionCheckInterval) {
      clearInterval(this.faceRecognitionCheckInterval);
      this.faceRecognitionCheckInterval = null;
    }
    if (this.faceRecognitionAutoCloseTimeout) {
      clearTimeout(this.faceRecognitionAutoCloseTimeout);
      this.faceRecognitionAutoCloseTimeout = null;
    }
  }

  async generateFaceDescriptorForProfile(employeeUID, imagePath) {
    try {
      console.log(`Generating face descriptor for employee ${employeeUID}...`);

      // Wait for face-api.js to be loaded
      const faceApiLoaded = await this.waitForFaceApi(5000);
      if (!faceApiLoaded) {
        console.warn('face-api.js not loaded, skipping descriptor generation');
        return { success: false, error: 'face-api.js not loaded' };
      }

      // ⭐ ENSURE CPU BACKEND
      try {
        if (faceapi.tf && faceapi.tf.setBackend) {
          await faceapi.tf.setBackend('cpu');
          await faceapi.tf.ready();
        }
      } catch (error) {
        console.warn('Could not set TensorFlow backend:', error);
      }

      // Ensure models are loaded
      if (!faceapi.nets.ssdMobilenetv1.isLoaded) {
        console.log('Loading face-api models for descriptor generation...');
        await faceapi.nets.ssdMobilenetv1.loadFromUri('models');
        await faceapi.nets.faceLandmark68Net.loadFromUri('models');
        await faceapi.nets.faceRecognitionNet.loadFromUri('models');
      }

      // Get descriptor path
      const pathResult = await electronAPI.invoke('generate-face-descriptor-from-image', imagePath);
      if (!pathResult.success) {
        return { success: false, error: pathResult.error };
      }

      // Load image and detect face
      const img = await faceapi.fetchImage(imagePath);
      const detection = await faceapi
        .detectSingleFace(img)
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!detection) {
        console.warn(`No face detected in profile image for ${employeeUID}`);
        return { success: false, error: 'No face detected in image' };
      }

      // Save descriptor to cache
      const saveResult = await electronAPI.invoke('save-face-descriptor', {
        path: pathResult.descriptorPath,
        descriptor: Array.from(detection.descriptor)
      });

      if (saveResult.success) {
        console.log(`✓ Face descriptor generated and cached for ${employeeUID}`);
        return { success: true, descriptorPath: pathResult.descriptorPath };
      } else {
        return { success: false, error: saveResult.error };
      }

    } catch (error) {
      console.error('Error generating face descriptor:', error);
      return { success: false, error: error.message };
    }
  }

  // Add this method to AttendanceApp class
  async generateDescriptorsForAllProfiles() {
    try {
      console.log('Checking for profiles without descriptors...');

      const employeesResult = await electronAPI.getEmployees();
      if (!employeesResult.success) return;

      const employees = employeesResult.data;
      let generated = 0;
      let skipped = 0;
      let errors = 0;

      // Wait for face-api.js
      const faceApiLoaded = await this.waitForFaceApi(5000);
      if (!faceApiLoaded) {
        console.warn('face-api.js not available for descriptor generation');
        return;
      }

      // ⭐ FORCE CPU BACKEND BEFORE LOADING MODELS
      try {
        if (faceapi.tf && faceapi.tf.setBackend) {
          console.log('Setting TensorFlow backend to CPU...');
          await faceapi.tf.setBackend('cpu');
          await faceapi.tf.ready();
          console.log('✓ TensorFlow backend set to CPU');
        }
      } catch (error) {
        console.warn('Could not set TensorFlow backend:', error);
        // Continue anyway - it will try to fall back to CPU
      }

      // Load models if not loaded
      if (!faceapi.nets.ssdMobilenetv1.isLoaded) {
        console.log('Loading face-api models on CPU...');
        await faceapi.nets.ssdMobilenetv1.loadFromUri('models');
        await faceapi.nets.faceLandmark68Net.loadFromUri('models');
        await faceapi.nets.faceRecognitionNet.loadFromUri('models');
        console.log('✓ Models loaded successfully');
      }

      console.log(`Processing ${employees.length} employees for descriptor generation...`);

      for (const employee of employees) {
        try {
          const pathResult = await electronAPI.invoke('generate-descriptor-for-employee', employee.uid);

          if (!pathResult.success) {
            skipped++;
            continue;
          }

          // Check if descriptor already exists
          const descriptorExists = await electronAPI.invoke('read-face-descriptor', pathResult.descriptorPath);
          if (descriptorExists.success) {
            console.log(`Descriptor exists for ${employee.first_name} ${employee.last_name}, skipping`);
            skipped++;
            continue;
          }

          // Generate new descriptor
          console.log(`Generating descriptor for ${employee.first_name} ${employee.last_name}...`);
          const result = await this.generateFaceDescriptorForProfile(employee.uid, pathResult.imagePath);

          if (result.success) {
            generated++;
            console.log(`✓ Generated descriptor for ${employee.first_name} ${employee.last_name}`);
          } else {
            errors++;
            console.warn(`Failed to generate descriptor for ${employee.first_name} ${employee.last_name}: ${result.error}`);
          }

          // Small delay to prevent blocking
          await new Promise(resolve => setTimeout(resolve, 100));

        } catch (error) {
          errors++;
          console.error(`Error generating descriptor for ${employee.uid}:`, error);
        }
      }

      console.log(`Descriptor generation complete: ${generated} generated, ${skipped} skipped, ${errors} errors`);

      return {
        success: true,
        generated,
        skipped,
        errors,
        total: employees.length
      };

    } catch (error) {
      console.error('Error in bulk descriptor generation:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }


  /**
   * Setup listener for server edit updates
   */
  setupServerEditSyncListener() {
    if (!this.electronAPI || !this.electronAPI.invoke) {
      console.warn('Server edit sync not available in electronAPI');
      return;
    }

    this.electronAPI.onServerEditsApplied((data) => {
      console.log('Server edits received:', data);

      // Show notification to user
      this.showServerEditNotification(data);

      // Refresh UI data
      this.handleServerEditsApplied(data);
    });

    console.log('✓ Server edit sync listener initialized');
  }

  /**
  * UPDATED: checkServerEdits method - Keep as manual trigger only
  */
  async checkServerEdits(silent = false) {
    if (!this.electronAPI || !this.electronAPI.invoke) {
      return { success: false, error: 'API not available' };
    }

    try {
      if (!silent) {
        this.showDownloadToast('🔄 Checking for server updates...', 'info');
      }

      const result = await this.electronAPI.invoke('check-server-edits', silent);

      if (result.success) {
        this.lastServerEditCheck = new Date();

        const hasChanges = result.applied > 0 || result.deleted > 0;

        if (hasChanges) {
          let message = '';
          if (result.applied > 0) message += `Applied: ${result.applied} edits `;
          if (result.deleted > 0) message += `Deleted: ${result.deleted} records `;
          if (result.corrected > 0) message += `Corrected: ${result.corrected} `;
          if (result.summariesRegenerated > 0) message += `Summaries: ${result.summariesRegenerated} regenerated `;
          if (result.summariesUploaded > 0) message += `Uploaded: ${result.summariesUploaded} summaries`;

          if (!silent) {
            this.showDownloadToast(`✅ ${message.trim()}`, 'success');
          }

          // Refresh UI to show updated data
          await this.handleServerEditsApplied({
            applied: result.applied,
            deleted: result.deleted,
            corrected: result.corrected || 0,
            summariesRegenerated: result.summariesRegenerated || 0,
            summariesUploaded: result.summariesUploaded || 0
          });
        } else {
          if (!silent) {
            this.showDownloadToast('✓ All records in sync with server', 'success');
          }
        }

        return result;
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error('Error checking server edits:', error);

      if (!silent) {
        this.showDownloadToast('❌ Server sync failed', 'error');
      }

      return { success: false, error: error.message };
    }
  }

  /**
 * UPDATED: showServerEditNotification method
 * Shows more detailed notification about what was synced
 */
  showServerEditNotification(data) {
    const {
      updated,
      deleted,
      corrected,
      summariesRegenerated,
      summariesUploaded,
      validated,
      message
    } = data;

    let notificationMessage = '📝 Server Changes Applied\n\n';

    if (updated > 0) {
      notificationMessage += `✏️ Updated: ${updated} record${updated > 1 ? 's' : ''}\n`;
    }

    if (deleted > 0) {
      notificationMessage += `🗑️ Deleted: ${deleted} record${deleted > 1 ? 's' : ''}\n`;
    }

    if (corrected > 0) {
      notificationMessage += `✅ Corrected: ${corrected} record${corrected > 1 ? 's' : ''}\n`;
    }

    if (validated > 0) {
      notificationMessage += `🔍 Validated: ${validated} employee-date${validated > 1 ? 's' : ''}\n`;
    }

    if (summariesRegenerated > 0) {
      notificationMessage += `🔄 Summaries Regenerated: ${summariesRegenerated}\n`;
    }

    if (summariesUploaded > 0) {
      notificationMessage += `📤 Summaries Uploaded: ${summariesUploaded}`;
    }

    // Show prominent notification
    this.showDownloadToast(notificationMessage, 'info');

    // Also show in status bar
    const statusMessage = message ||
      `Synced ${updated} updates, ${deleted} deletions, ${summariesRegenerated} summaries regenerated`;
    this.showStatus(statusMessage, 'success');

    // Play notification sound if available
    this.playNotificationSound();
  }

  /**
   * Helper method to explain the sync flow to users
   */
  getServerEditSyncFlowExplanation() {
    return `
    <div class="sync-flow-explanation">
      <h4>📋 How Server Edit Sync Works:</h4>
      <ol>
        <li><strong>Server Edit:</strong> When you edit attendance on the server, it:
          <ul>
            <li>✏️ Updates the attendance record</li>
            <li>🗑️ Deletes the affected daily summary immediately</li>
            <li>⏳ Waits for client to regenerate the summary</li>
          </ul>
        </li>
        <li><strong>Client Download:</strong> This app checks the server every 2 minutes and:
          <ul>
            <li>📥 Downloads edited/deleted attendance records</li>
            <li>🔄 Applies them to local database</li>
            <li>🗑️ Deletes affected local summaries (matching server)</li>
          </ul>
        </li>
        <li><strong>Client Validation:</strong> After applying edits:
          <ul>
            <li>🔍 Validates all affected attendance data</li>
            <li>✅ Corrects any time calculation errors</li>
            <li>⚖️ Ensures 8-hour rule compliance</li>
          </ul>
        </li>
        <li><strong>Client Regeneration:</strong> Creates fresh summaries from validated data:
          <ul>
            <li>📊 Generates new daily summaries</li>
            <li>✨ Uses corrected hours from validation</li>
            <li>💾 Saves summaries locally</li>
          </ul>
        </li>
        <li><strong>Client Upload:</strong> Sends regenerated summaries back to server:
          <ul>
            <li>📤 Uploads validated summaries</li>
            <li>✅ Server receives correct, validated data</li>
            <li>🎯 Both server and client are now in sync</li>
          </ul>
        </li>
      </ol>
      <p class="sync-flow-note">
        <strong>⚠️ Important:</strong> There's a brief moment where summaries don't exist on the server 
        (after deletion, before client upload). This is correct behavior - it prevents serving 
        incorrect data. The client regenerates and uploads quickly (usually under 5 seconds).
      </p>
    </div>
  `;
  }

  /**
  * UPDATED: handleServerEditsApplied method
  * This now expects that the server has ALREADY deleted the summaries
  * The client just needs to validate, regenerate, and upload them back
  */
  async handleServerEditsApplied(data) {
    try {
      console.log('Handling server edits - server already deleted summaries');
      console.log('Edit data:', data);

      // Step 1: Refresh UI to show updated attendance data
      // Note: Summary display will be empty since server deleted them
      await Promise.all([
        this.loadTodayAttendance(),
        this.loadDailySummary() // This will show empty/missing summaries
      ]);

      console.log('✓ UI refreshed - summaries are now empty (server deleted them)');

      // Step 2: Validate and regenerate summaries locally
      // This is the KEY STEP - it will create fresh summaries from validated data
      if (data.updated > 0 || data.deleted > 0) {
        console.log('Validating and regenerating summaries after server edits...');

        // The validation will:
        // 1. Validate all affected attendance records
        // 2. Correct any calculation errors
        // 3. Regenerate daily summaries
        await this.validateAttendanceData();

        console.log('✓ Summaries regenerated locally');
      }

      // Step 3: Refresh UI again to show the NEW summaries
      await this.loadDailySummary();
      console.log('✓ UI refreshed with new summaries');

      // Step 4: Sync the regenerated summaries back to server
      // The summaries we just regenerated need to go back to the server
      if (data.updated > 0 || data.deleted > 0) {
        console.log('Syncing regenerated summaries back to server...');

        // Wait a moment to ensure summaries are saved locally
        setTimeout(async () => {
          // This will upload the regenerated summaries
          const summarySync = await this.performSummarySync(true, 0, false);

          if (summarySync.success) {
            console.log(`✓ Uploaded ${summarySync.syncedCount || 0} regenerated summaries to server`);
            this.showDownloadToast(
              `✅ Summaries regenerated and uploaded to server`,
              'success'
            );
          } else {
            console.warn('⚠️ Failed to upload regenerated summaries:', summarySync.error);
          }
        }, 2000); // Wait 2 seconds for local saves to complete
      }

      // Step 5: Update sync info if settings panel is open
      if (document.getElementById('settingsModal')?.classList.contains('show')) {
        await this.loadServerEditSyncInfo();
      }

      console.log('✓ Server edit handling complete');
    } catch (error) {
      console.error('Error handling server edits:', error);
      this.showStatus('Error processing server updates', 'error');
    }
  }

  /**
  * UPDATED: loadServerEditSyncInfo - Update UI text for manual sync
  */
  async loadServerEditSyncInfo() {
    if (!this.electronAPI || !this.electronAPI.invoke) {
      return;
    }

    try {
      const syncInfoResult = await this.electronAPI.invoke('get-server-edit-last-sync');

      const syncInfoElement = document.getElementById('serverEditSyncInfo');

      if (!syncInfoElement) {
        console.warn('serverEditSyncInfo element not found');
        return;
      }

      let lastSyncText = 'Never';
      let syncStats = 'No sync data';

      if (syncInfoResult && syncInfoResult.success !== false) {
        if (syncInfoResult.lastSyncTimestamp) {
          const syncDate = new Date(syncInfoResult.lastSyncTimestamp);
          const now = new Date();
          const minutesAgo = Math.floor((now - syncDate) / (1000 * 60));

          lastSyncText = minutesAgo < 1 ? 'Just now' :
            minutesAgo < 60 ? `${minutesAgo} minutes ago` :
              syncDate.toLocaleString();
        }

        // Get history for last sync stats
        const historyResult = await this.electronAPI.invoke('get-server-edit-sync-history', 1);

        if (historyResult && historyResult.success && historyResult.data && historyResult.data.length > 0) {
          const lastSync = historyResult.data[0];
          const parts = [];

          if (lastSync.applied > 0) parts.push(`${lastSync.applied} applied`);
          if (lastSync.deleted > 0) parts.push(`${lastSync.deleted} deleted`);
          if (lastSync.corrected > 0) parts.push(`${lastSync.corrected} corrected`);
          if (lastSync.summariesRegenerated > 0) parts.push(`${lastSync.summariesRegenerated} summaries`);
          if (lastSync.summariesUploaded > 0) parts.push(`${lastSync.summariesUploaded} uploaded`);

          syncStats = parts.length > 0 ? parts.join(', ') : 'No changes';
        }
      }

      syncInfoElement.innerHTML = `
      <div class="sync-info-item">
        <strong>Last Manual Check:</strong> ${lastSyncText}
      </div>
      <div class="sync-info-item">
        <strong>Last Sync Results:</strong> ${syncStats}
      </div>
      <div class="sync-info-item">
        <strong>Sync Mode:</strong> <span class="status-badge info">Manual Only</span>
      </div>
      <div class="sync-info-item">
        <strong>Summary Handling:</strong>
        <span class="info-text">Server deletes → Client regenerates → Client uploads</span>
      </div>
      <div class="sync-info-item">
        <em>💡 Tip: Click "Check Server Edits Now" button below to manually sync changes from the server.</em>
      </div>
    `;

      // Also show recent history if available
      const historyResult = await this.electronAPI.invoke('get-server-edit-sync-history', 5);

      if (historyResult && historyResult.success && historyResult.data && historyResult.data.length > 0) {
        const historyHtml = `
        <div class="sync-history">
          <strong>Recent Sync History:</strong>
          <table class="sync-history-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Applied</th>
                <th>Deleted</th>
                <th>Corrected</th>
                <th>Summaries</th>
                <th>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              ${historyResult.data.map(log => `
                <tr class="${log.success ? '' : 'error-row'}">
                  <td>${new Date(log.timestamp).toLocaleString()}</td>
                  <td class="${log.applied > 0 ? 'highlight-info' : ''}">
                    ${log.applied || 0}
                  </td>
                  <td class="${log.deleted > 0 ? 'highlight-warning' : ''}">
                    ${log.deleted || 0}
                  </td>
                  <td class="${log.corrected > 0 ? 'highlight-success' : ''}">
                    ${log.corrected || 0}
                  </td>
                  <td class="${log.summariesRegenerated > 0 ? 'highlight-info' : ''}">
                    ${log.summariesRegenerated || 0}
                  </td>
                  <td class="${log.summariesUploaded > 0 ? 'highlight-success' : ''}">
                    ${log.summariesUploaded || 0}
                  </td>
                </tr>
                ${log.error ? `
                  <tr class="error-detail">
                    <td colspan="6">
                      <strong>Error:</strong> ${log.error}
                    </td>
                  </tr>
                ` : ''}
              `).join('')}
            </tbody>
          </table>
        </div>
      `;

        syncInfoElement.innerHTML += historyHtml;
      }
    } catch (error) {
      console.error('Error loading server edit sync info:', error);
      const syncInfoElement = document.getElementById('serverEditSyncInfo');
      if (syncInfoElement) {
        syncInfoElement.innerHTML = `
        <div class="sync-info-item error">
          <strong>Error:</strong> Failed to load sync information
          <br><small>${error.message}</small>
        </div>
      `;
      }
    }
  }

  /**
   * Play notification sound
   */
  playNotificationSound() {
    try {
      const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuFzvLZizcIHGm98OScTQwOUKrm8K1gGgU7k9byz3osBSh+zPLaizsIGGS57OihUhEJTKXh8bJeGAU7k9byz3osBSh+zPLaizsIGGS57OihUhEJTKXh8bJeGAU7k9byz3osBSh+zPLaizsIGGS57OihUhEJTKXh8bJeGAU7k9byz3osBSh+zPLaizsIGGS57OihUhEJTKXh8bJeGAU7k9byz3osBSh+zPLaizsIGGS57OihUhEJTKXh8bJeGAU7k9byz3osBSh+zPLaizsIGGS57OihUhEJTKXh8bJeGAU7k9byz3osBSh+zPLaizsIGGS57OihUhEJTKXh8bJeGAU7k9byz3osBSh+zPLaizsIGGS57OihUhEJTKXh8bJeGAU7k9byz3osBSh+zPLaizsIGGS57OihUhEJTKXh8bJeGAU=');
      audio.volume = 0.3;
      audio.play().catch(err => console.log('Could not play sound:', err));
    } catch (error) {
      // Sound playback failed, ignore
    }
  }

  /**
  * UPDATED: setupServerEditSyncUI - Update button text and description
  */
  setupServerEditSyncUI() {
    const syncPanel = document.getElementById('syncPanel');

    if (!syncPanel) {
      console.warn('Sync panel not found, cannot setup server edit sync UI');
      return;
    }

    if (document.getElementById('serverEditSyncInfo')) {
      console.log('Server edit sync UI already setup');
      return;
    }

    const serverEditSection = document.createElement('div');
    serverEditSection.className = 'settings-section server-edit-sync-section';
    serverEditSection.innerHTML = `
    <h3>📝 Server Edit Sync (Manual)</h3>
    <p class="section-description">
      Manually check for attendance corrections made on the server and apply them to local records.
      <br><strong>Note:</strong> This is a manual process - click the button below when you want to sync.
    </p>
    <div id="serverEditSyncInfo" class="sync-info">
      <div class="loading">Loading sync information...</div>
    </div>
    <div class="button-group" style="margin-top: 15px;">
      <button id="checkServerEditsNowBtn" class="primary-button">
        🔄 Check Server Edits Now
      </button>
      <button id="viewServerEditHistoryBtn" class="secondary-button">
        📊 View Sync History
      </button>
    </div>
    <div class="sync-info-item" style="margin-top: 10px; padding: 10px; background: #f0f9ff; border-left: 4px solid #3b82f6;">
      <strong>💡 How to use:</strong>
      <ul style="margin: 5px 0 0 20px; padding: 0;">
        <li>Click "Check Server Edits Now" whenever you want to download changes from the server</li>
        <li>The system will download edits, validate data, regenerate summaries, and upload them back</li>
        <li>Check the history to see previous sync operations</li>
      </ul>
    </div>
  `;

    const lastSection = syncPanel.querySelector('.settings-section:last-child');
    if (lastSection) {
      syncPanel.insertBefore(serverEditSection, lastSection);
    } else {
      syncPanel.appendChild(serverEditSection);
    }

    // Add event listeners
    const checkNowBtn = document.getElementById('checkServerEditsNowBtn');
    const viewHistoryBtn = document.getElementById('viewServerEditHistoryBtn');

    if (checkNowBtn) {
      checkNowBtn.addEventListener('click', async () => {
        checkNowBtn.disabled = true;
        checkNowBtn.textContent = '🔄 Checking...';

        try {
          await this.checkServerEdits(false);
        } catch (error) {
          console.error('Error checking server edits:', error);
          this.showStatus(`Error: ${error.message}`, 'error');
        } finally {
          checkNowBtn.disabled = false;
          checkNowBtn.textContent = '🔄 Check Server Edits Now';

          await this.loadServerEditSyncInfo();
        }
      });
    }

    if (viewHistoryBtn) {
      viewHistoryBtn.addEventListener('click', () => {
        this.showServerEditSyncHistory();
      });
    }

    this.loadServerEditSyncInfo();

    console.log('✓ Server edit sync UI setup complete (Manual mode)');
  }

  /**
  * FIXED: showServerEditSyncHistory method
  * Now properly checks for API availability
  */
  async showServerEditSyncHistory() {
    if (!this.electronAPI || !this.electronAPI.invoke) {
      this.showStatus('Server edit sync history not available', 'error');
      return;
    }

    try {
      const result = await this.electronAPI.invoke('get-server-edit-sync-history', 20);

      if (!result || !result.success) {
        throw new Error(result?.error || 'Failed to load sync history');
      }

      const history = result.data || [];

      // Create modal
      const modal = document.createElement('div');
      modal.className = 'modal show';
      modal.id = 'serverEditHistoryModal';
      modal.innerHTML = `
      <div class="modal-content" style="max-width: 900px;">
        <div class="modal-header">
          <h2>📊 Server Edit Sync History</h2>
          <button class="close-button" onclick="this.closest('.modal').remove()">×</button>
        </div>
        <div class="modal-body">
          ${history.length === 0 ? `
            <div class="empty-state">
              <p>No sync history available yet.</p>
              <p>Server edit sync will appear here once the system starts checking for updates.</p>
            </div>
          ` : `
            <table class="data-table">
              <thead>
                <tr>
                  <th>Date & Time</th>
                  <th>Downloaded</th>
                  <th>Applied</th>
                  <th>Deleted</th>
                  <th>Corrected</th>
                  <th>Summaries</th>
                  <th>Uploaded</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${history.map(log => `
                  <tr class="${log.success ? '' : 'error-row'}">
                    <td>${new Date(log.timestamp).toLocaleString()}</td>
                    <td>${log.downloaded || 0}</td>
                    <td class="${log.applied > 0 ? 'highlight-success' : ''}">
                      ${log.applied || 0}
                    </td>
                    <td class="${log.deleted > 0 ? 'highlight-warning' : ''}">
                      ${log.deleted || 0}
                    </td>
                    <td class="${log.corrected > 0 ? 'highlight-info' : ''}">
                      ${log.corrected || 0}
                    </td>
                    <td class="${log.summariesRegenerated > 0 ? 'highlight-info' : ''}">
                      ${log.summariesRegenerated || 0}
                    </td>
                    <td class="${log.summariesUploaded > 0 ? 'highlight-success' : ''}">
                      ${log.summariesUploaded || 0}
                    </td>
                    <td>
                      ${log.error ?
          '<span class="status-badge error">Error</span>' :
          log.success ?
            '<span class="status-badge success">Success</span>' :
            '<span class="status-badge warning">Partial</span>'}
                    </td>
                  </tr>
                  ${log.error ? `
                    <tr class="error-detail">
                      <td colspan="8">
                        <strong>Error:</strong> 
                        <pre style="margin: 5px 0; padding: 10px; background: #fee; border-radius: 4px; overflow-x: auto;">${log.error}</pre>
                      </td>
                    </tr>
                  ` : ''}
                `).join('')}
              </tbody>
            </table>
            
            <div class="history-stats" style="margin-top: 20px; padding: 15px; background: #f5f5f5; border-radius: 8px;">
              <h3>Summary Statistics</h3>
              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-top: 10px;">
                <div>
                  <strong>Total Syncs:</strong> ${history.length}
                </div>
                <div>
                  <strong>Successful:</strong> ${history.filter(h => h.success).length}
                </div>
                <div>
                  <strong>Failed:</strong> ${history.filter(h => !h.success).length}
                </div>
                <div>
                  <strong>Total Applied:</strong> ${history.reduce((sum, h) => sum + (h.applied || 0), 0)}
                </div>
                <div>
                  <strong>Total Deleted:</strong> ${history.reduce((sum, h) => sum + (h.deleted || 0), 0)}
                </div>
                <div>
                  <strong>Total Corrected:</strong> ${history.reduce((sum, h) => sum + (h.corrected || 0), 0)}
                </div>
              </div>
            </div>
          `}
        </div>
        <div class="modal-footer">
          <button class="secondary-button" onclick="this.closest('.modal').remove()">
            Close
          </button>
        </div>
      </div>
    `;

      document.body.appendChild(modal);

      // Close on background click
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.remove();
        }
      });
    } catch (error) {
      console.error('Error showing sync history:', error);
      this.showStatus(`Failed to load sync history: ${error.message}`, 'error');
    }
  }



  async setupImageWithFallback(imgElement, employee_uid, altText) {
    if (!imgElement || !employee_uid) {
      console.warn("setupImageWithFallback: Missing required parameters");
      return;
    }

    // Clear existing handlers
    imgElement.onerror = null;
    imgElement.onload = null;

    // Set default image immediately
    const defaultImg = this.getDefaultImageDataURL();
    imgElement.src = defaultImg;
    imgElement.alt = altText || "Profile Image";

    try {
      // Check renderer cache first
      const cacheKey = `img_${employee_uid}`;
      if (this.imageCache && this.imageCache.has(cacheKey)) {
        const cached = this.imageCache.get(cacheKey);
        if (cached && cached.data && Date.now() - cached.timestamp < 300000) {
          // 5 minutes
          console.log(`Renderer image cache hit: ${employee_uid}`);
          imgElement.src = cached.data;
          return;
        } else {
          this.imageCache.delete(cacheKey);
        }
      }

      // Try fast profile lookup if available
      if (this.electronAPI && this.electronAPI.invoke) {
        try {
          const profileResult = await this.electronAPI.invoke(
            "get-profile-fast",
            employee_uid
          );

          if (
            profileResult.success &&
            profileResult.data &&
            profileResult.data.image
          ) {
            const dataUrl = `data:image/jpeg;base64,${profileResult.data.image}`;

            // Test image validity before setting
            const testImg = new Image();
            testImg.onload = () => {
              imgElement.src = dataUrl;

              // Cache in renderer
              if (this.imageCache) {
                this.imageCache.set(cacheKey, {
                  data: dataUrl,
                  timestamp: Date.now(),
                });
              }

              console.log(`Fast profile image loaded: ${employee_uid}`);
            };

            testImg.onerror = () => {
              console.warn(`Invalid fast profile image: ${employee_uid}`);
              this.tryFileSystemImage(imgElement, employee_uid, altText);
            };

            testImg.src = dataUrl;
            return;
          }
        } catch (error) {
          console.warn(
            `Fast profile lookup failed for ${employee_uid}:`,
            error.message
          );
        }
      }

      // Fallback to file system
      await this.tryFileSystemImage(imgElement, employee_uid, altText);
    } catch (error) {
      console.error(`Error loading profile image for ${employee_uid}:`, error);
      // Keep default image
    }
  }

  // Helper method for file system image loading
  async tryFileSystemImage(imgElement, employee_uid, altText) {
    try {
      if (this.electronAPI && this.electronAPI.getLocalProfilePath) {
        const result = await this.electronAPI.getLocalProfilePath(employee_uid);

        if (result.success && result.path) {
          const normalizedPath = result.path.replace(/\\/g, "/");
          const fileUrl = normalizedPath.startsWith("file:///")
            ? normalizedPath
            : `file:///${normalizedPath}`;

          const testImg = new Image();
          testImg.onload = () => {
            imgElement.src = fileUrl;
            // console.log(`File system profile image loaded: ${employee_uid}`);

            // Cache the file URL too
            if (this.imageCache) {
              this.imageCache.set(`img_${employee_uid}`, {
                data: fileUrl,
                timestamp: Date.now(),
              });
            }
          };

          testImg.onerror = () => {
            console.log(`File system profile not found: ${employee_uid}`);
            // Keep default image
          };

          testImg.src = fileUrl;
        }
      }
    } catch (error) {
      console.warn(
        `File system image load failed for ${employee_uid}:`,
        error.message
      );
      // Keep default image
    }
  }

  // PERFORMANCE: Start cache monitoring
  startCacheMonitoring() {
    // Monitor cache performance every 2 minutes
    this.cacheStatsInterval = setInterval(async () => {
      try {
        const cacheStats = await this.electronAPI.getCacheStats();
        if (cacheStats.success) {
          this.lastCacheStats = cacheStats.data;

          // Log cache performance in development
          if (console && typeof console.log === "function") {
            const stats = cacheStats.data;
            console.log("Cache Performance:", {
              profileCache: `${stats.profileCache.size}/${stats.profileCache.max}`,
              imageCache: `${stats.imageCache.size}/${stats.imageCache.max}`,
              rendererProfile: this.profileCache.size,
              rendererImage: this.imageCache.size,
              preloaded: this.preloadedProfiles.size,
            });
          }

          // Update performance display if tab is open
          this.updatePerformanceDisplay(cacheStats.data);
        }
      } catch (error) {
        console.warn("Cache monitoring error:", error);
      }
    }, 120000); // 2 minutes
  }

  // PERFORMANCE: Update performance display in UI
  updatePerformanceDisplay(cacheStats) {
    try {
      // Update main process cache size
      const mainProcessElement = document.getElementById(
        "mainProcessCacheSize"
      );
      if (mainProcessElement && cacheStats) {
        const totalMain =
          (cacheStats.profileCache?.size || 0) +
          (cacheStats.imageCache?.size || 0);
        mainProcessElement.textContent = totalMain.toString();
      }

      // Update renderer cache size
      const rendererElement = document.getElementById("rendererCacheSize");
      if (rendererElement) {
        const totalRenderer = this.profileCache.size + this.imageCache.size;
        rendererElement.textContent = totalRenderer.toString();
      }

      // Update preloaded count
      const preloadedElement = document.getElementById("preloadedCount");
      if (preloadedElement) {
        preloadedElement.textContent = this.preloadedProfiles.size.toString();
      }

      // Update cache details
      const profileCacheInfo = document.getElementById("profileCacheInfo");
      if (profileCacheInfo && cacheStats.profileCache) {
        profileCacheInfo.textContent = `${cacheStats.profileCache.size}/${cacheStats.profileCache.max} slots used`;
      }

      const imageCacheInfo = document.getElementById("imageCacheInfo");
      if (imageCacheInfo && cacheStats.imageCache) {
        imageCacheInfo.textContent = `${cacheStats.imageCache.size}/${cacheStats.imageCache.max} slots used`;
      }

      // Update last cleanup time
      const lastCleanup = document.getElementById("lastCleanup");
      if (lastCleanup) {
        lastCleanup.textContent = new Date().toLocaleTimeString();
      }

      // Calculate and update cache hit rate (simplified)
      const cacheHitRate = document.getElementById("cacheHitRate");
      if (cacheHitRate) {
        const totalCached =
          this.profileCache.size + this.preloadedProfiles.size;
        const hitRate =
          totalCached > 0 ? Math.min(95, 60 + totalCached * 2) : 0;
        cacheHitRate.textContent = `${hitRate}%`;
      }
    } catch (error) {
      console.warn("Error updating performance display:", error);
    }
  }

  // PERFORMANCE: Clear all caches
  async clearAllCaches() {
    try {
      const clearBtn = document.getElementById("clearCacheBtn");
      if (clearBtn) {
        clearBtn.classList.add("loading");
        clearBtn.textContent = "Clearing...";
        clearBtn.disabled = true;
      }

      // Clear renderer caches
      this.profileCache.clear();
      this.imageCache.clear();
      this.preloadedProfiles.clear();

      // Clear main process caches
      if (this.electronAPI && this.electronAPI.clearProfileCache) {
        const result = await this.electronAPI.clearProfileCache();
        if (result.success) {
          console.log("✓ All caches cleared successfully");
          this.showStatus("All caches cleared successfully", "success");

          if (clearBtn) {
            clearBtn.classList.add("success");
            clearBtn.textContent = "✓ Cleared";
          }
        } else {
          throw new Error(result.error || "Failed to clear main process cache");
        }
      } else {
        console.log(
          "✓ Renderer caches cleared (main process cache not available)"
        );
        this.showStatus("Renderer caches cleared", "success");

        if (clearBtn) {
          clearBtn.classList.add("success");
          clearBtn.textContent = "✓ Cleared";
        }
      }

      // Refresh performance display
      setTimeout(() => {
        this.refreshPerformanceStats();
      }, 1000);
    } catch (error) {
      console.error("Error clearing caches:", error);
      this.showStatus("Error clearing caches: " + error.message, "error");

      const clearBtn = document.getElementById("clearCacheBtn");
      if (clearBtn) {
        clearBtn.classList.add("error");
        clearBtn.textContent = "✗ Error";
      }
    } finally {
      // Reset button state after 3 seconds
      setTimeout(() => {
        const clearBtn = document.getElementById("clearCacheBtn");
        if (clearBtn) {
          clearBtn.classList.remove("loading", "success", "error");
          clearBtn.textContent = "🗑️ Clear All Caches";
          clearBtn.disabled = false;
        }
      }, 3000);
    }
  }

  // PERFORMANCE: Get cache statistics for display
  async getCacheStatistics() {
    try {
      const mainStats = await this.electronAPI.getCacheStats();

      return {
        mainProcess: mainStats.success ? mainStats.data : null,
        renderer: {
          profileCache: this.profileCache.size,
          imageCache: this.imageCache.size,
          preloadedProfiles: this.preloadedProfiles.size,
        },
        combined: {
          totalProfiles:
            (mainStats.success ? mainStats.data.profileCache.size : 0) +
            this.profileCache.size,
          totalImages:
            (mainStats.success ? mainStats.data.imageCache.size : 0) +
            this.imageCache.size,
        },
      };
    } catch (error) {
      console.error("Error getting cache statistics:", error);
      return null;
    }
  }

  // PERFORMANCE: Refresh performance statistics
  async refreshPerformanceStats() {
    try {
      const refreshBtn = document.getElementById("refreshStatsBtn");
      if (refreshBtn) {
        refreshBtn.classList.add("loading");
        refreshBtn.textContent = "Refreshing...";
        refreshBtn.disabled = true;
      }

      // Get fresh cache statistics
      const stats = await this.getCacheStatistics();
      if (stats && stats.mainProcess) {
        this.lastCacheStats = stats.mainProcess;
        this.updatePerformanceDisplay(stats.mainProcess);

        if (refreshBtn) {
          refreshBtn.classList.add("success");
          refreshBtn.textContent = "✓ Refreshed";
        }

        console.log("Performance stats refreshed:", stats);
      } else {
        throw new Error("Failed to get cache statistics");
      }
    } catch (error) {
      console.error("Error refreshing performance stats:", error);

      const refreshBtn = document.getElementById("refreshStatsBtn");
      if (refreshBtn) {
        refreshBtn.classList.add("error");
        refreshBtn.textContent = "✗ Error";
      }
    } finally {
      // Reset button state after 2 seconds
      setTimeout(() => {
        const refreshBtn = document.getElementById("refreshStatsBtn");
        if (refreshBtn) {
          refreshBtn.classList.remove("loading", "success", "error");
          refreshBtn.textContent = "🔄 Refresh Stats";
          refreshBtn.disabled = false;
        }
      }, 2000);
    }
  }

  getDefaultImageDataURL() {
    const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <circle cx="50" cy="50" r="50" fill="#f0f0f0"/>
    <circle cx="50" cy="35" r="15" fill="#ccc"/>
    <ellipse cx="50" cy="70" rx="20" ry="15" fill="#ccc"/>
  </svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  async initializePerformanceCaches() {
    console.log("Initializing renderer-side caches...");

    try {
      // Initialize renderer caches
      if (!this.profileCache) this.profileCache = new Map();
      if (!this.imageCache) this.imageCache = new Map();
      if (!this.preloadedProfiles) this.preloadedProfiles = new Set();

      // Get cache statistics from main process
      if (this.electronAPI && this.electronAPI.getCacheStats) {
        const cacheStats = await this.electronAPI.getCacheStats();
        if (cacheStats.success) {
          this.lastCacheStats = cacheStats.data;
          console.log("Main process cache stats received:", cacheStats.data);
        } else {
          console.warn("Failed to get main process cache stats");
        }
      }

      // Preload frequently used profiles
      await this.preloadAllProfilesAndImages();

      console.log("✓ Renderer caches initialized successfully");
      return true;
    } catch (error) {
      console.error("Cache initialization error:", error);
      return false;
    }
  }

  // NEW: Preload ALL profiles and images into memory for face recognition
  async preloadAllProfilesAndImages() {
    if (!this.electronAPI) {
      console.log("No electronAPI available for comprehensive preloading");
      return;
    }

    try {
      console.log(
        "Starting comprehensive preload of all profiles and images..."
      );

      // Get ALL employees
      const employeesResult = await this.electronAPI.getEmployees();
      if (
        !employeesResult.success ||
        !employeesResult.data ||
        !Array.isArray(employeesResult.data)
      ) {
        console.warn("Invalid employee data for comprehensive preloading");
        return;
      }

      if (employeesResult.data.length === 0) {
        console.log("No employees available for comprehensive preloading");
        return;
      }

      const allEmployees = employeesResult.data;
      console.log(
        `Preloading ${allEmployees.length} employee profiles and images...`
      );

      // Phase 1: Preload all profile data to main process cache
      const barcodes = allEmployees.map((emp) => emp.uid).filter((uid) => uid);

      if (this.electronAPI.preloadScanningSession) {
        const profilePreloadResult =
          await this.electronAPI.preloadScanningSession(barcodes);

        if (profilePreloadResult.success) {
          barcodes.forEach((barcode) => {
            if (this.preloadedProfiles) {
              this.preloadedProfiles.add(barcode);
            }
          });
          console.log(
            `✓ Profile preload: ${profilePreloadResult.preloaded}/${profilePreloadResult.total} profiles cached`
          );
        } else {
          console.warn(
            "Profile preload failed:",
            profilePreloadResult.error || "Unknown error"
          );
        }
      }

      // Phase 2: Preload all images into renderer memory cache
      let imageLoadedCount = 0;
      let imageErrorCount = 0;

      console.log("Starting image preload phase...");

      // Process images in batches to avoid overwhelming the system
      const batchSize = 10;
      const batches = [];

      for (let i = 0; i < allEmployees.length; i += batchSize) {
        batches.push(allEmployees.slice(i, i + batchSize));
      }

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        console.log(
          `Processing image batch ${batchIndex + 1}/${batches.length} (${batch.length
          } employees)...`
        );

        // Process batch in parallel
        const batchPromises = batch.map(async (employee) => {
          try {
            await this.preloadEmployeeImage(
              employee.uid,
              `${employee.first_name} ${employee.last_name}`
            );
            imageLoadedCount++;
          } catch (error) {
            console.warn(
              `Failed to preload image for ${employee.uid}:`,
              error.message
            );
            imageErrorCount++;
          }
        });

        await Promise.allSettled(batchPromises);

        // Small delay between batches to prevent overwhelming the system
        if (batchIndex < batches.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      console.log(
        `✓ Image preload completed: ${imageLoadedCount} loaded, ${imageErrorCount} failed`
      );

      // Final summary
      const totalCached = this.profileCache.size + this.imageCache.size;
      console.log(`🚀 Comprehensive preload completed:`);
      console.log(
        `   - Profiles: ${this.preloadedProfiles.size}/${allEmployees.length}`
      );
      console.log(`   - Images: ${imageLoadedCount}/${allEmployees.length}`);
      console.log(`   - Total cache entries: ${totalCached}`);
    } catch (error) {
      console.error("Comprehensive preload error:", error);
    }
  }

  // Helper method to preload individual employee image
  async preloadEmployeeImage(employee_uid, altText) {
    return new Promise(async (resolve, reject) => {
      try {
        const cacheKey = `img_${employee_uid}`;
        console.log(`Preloading image with cache key: "${cacheKey}" for employee ${employee_uid}`);

        // Skip if already cached
        if (this.imageCache && this.imageCache.has(cacheKey)) {
          const cached = this.imageCache.get(cacheKey);
          if (cached && cached.data && Date.now() - cached.timestamp < 3600000) { // 1 hour cache
            console.log(`Image already cached for ${employee_uid}`);
            resolve("cached");
            return;
          } else {
            this.imageCache.delete(cacheKey);
          }
        }

        let imageData = null;
        let imageSource = null;

        // Method 1: Try fast profile lookup first
        if (this.electronAPI && this.electronAPI.invoke) {
          try {
            const profileResult = await this.electronAPI.invoke(
              "get-profile-fast",
              employee_uid
            );

            if (
              profileResult.success &&
              profileResult.data &&
              profileResult.data.image
            ) {
              // FIXED: Create proper data URL
              imageData = `data:image/jpeg;base64,${profileResult.data.image}`;
              imageSource = 'database';
              console.log(`✓ Got image from database for ${employee_uid}`);
            }
          } catch (error) {
            console.warn(`Fast profile lookup failed for ${employee_uid}:`, error.message);
          }
        }

        // Method 2: Try file system if no database image
        if (!imageData) {
          try {
            if (this.electronAPI && this.electronAPI.getLocalProfilePath) {
              const result = await this.electronAPI.getLocalProfilePath(employee_uid);

              if (result.success && result.path) {
                const normalizedPath = result.path.replace(/\\/g, "/");
                const fileUrl = normalizedPath.startsWith("file:///")
                  ? normalizedPath
                  : `file:///${normalizedPath}`;

                // Test if file exists by trying to load it
                const testImg = new Image();

                const imageLoadPromise = new Promise((resolveImg, rejectImg) => {
                  testImg.onload = () => {
                    imageData = fileUrl;
                    imageSource = 'filesystem';
                    console.log(`✓ Got image from filesystem for ${employee_uid}`);
                    resolveImg();
                  };

                  testImg.onerror = () => {
                    console.log(`File system profile not found: ${employee_uid}`);
                    rejectImg(new Error('File not found'));
                  };

                  // Set timeout for file loading
                  setTimeout(() => {
                    rejectImg(new Error('File load timeout'));
                  }, 5000);
                });

                testImg.src = fileUrl;

                try {
                  await imageLoadPromise;
                } catch (fileError) {
                  console.log(`File load failed for ${employee_uid}: ${fileError.message}`);
                  imageData = null;
                }
              }
            }
          } catch (error) {
            console.warn(`File system image load failed for ${employee_uid}:`, error.message);
          }
        }

        // Cache the image if we found one
        if (imageData && this.imageCache) {
          this.imageCache.set(cacheKey, {
            data: imageData,
            timestamp: Date.now(),
            source: imageSource,
          });
          console.log(`✓ Cached image for ${employee_uid} from ${imageSource}`);
          resolve(imageSource);
        } else {
          console.log(`No image found for employee ${employee_uid}`);
          resolve("not_found");
        }

      } catch (error) {
        console.error(`Error preloading image for ${employee_uid}:`, error);
        reject(error);
      }
    });
  }

  // Helper method for file system image preloading
  async tryFileSystemImageForPreload(employee_uid) {
    return new Promise(async (resolve, reject) => {
      try {
        if (this.electronAPI && this.electronAPI.getLocalProfilePath) {
          const result = await this.electronAPI.getLocalProfilePath(
            employee_uid
          );

          if (result.success && result.path) {
            const normalizedPath = result.path.replace(/\\/g, "/");
            const fileUrl = normalizedPath.startsWith("file:///")
              ? normalizedPath
              : `file:///${normalizedPath}`;

            const testImg = new Image();
            testImg.onload = () => {
              // Cache the file URL
              if (this.imageCache) {
                const cacheKey = `img_${employee_uid}`;
                this.imageCache.set(cacheKey, {
                  data: fileUrl,
                  timestamp: Date.now(),
                  source: "filesystem",
                });
              }
              resolve("filesystem");
            };

            testImg.onerror = () => {
              resolve("default"); // Use default image
            };

            testImg.src = fileUrl;
          } else {
            resolve("default");
          }
        } else {
          resolve("default");
        }
      } catch (error) {
        reject(error);
      }
    });
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
      this.performAttendanceSync(true);
    }, this.syncSettings.interval);

    setTimeout(() => {
      this.performAttendanceSync(true, 0, true);
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
      if (retryCount === 0) {
        // Only validate on first attempt, not retries
        try {
          if (!silent) {
            this.showStatus(
              "Validating attendance data before sync...",
              "info"
            );
          }

          const validationResult =
            await this.electronAPI.validateAndCorrectUnsyncedRecords({
              autoCorrect: true,
              updateSyncStatus: false, // Don't change sync status during validation
            });

          if (
            validationResult.success &&
            validationResult.data.summary.correctedRecords > 0
          ) {
            const corrected = validationResult.data.summary.correctedRecords;
            console.log(`Pre-sync validation: ${corrected} records corrected`);

            if (!silent) {
              this.showStatus(
                `Validated and corrected ${corrected} records before sync`,
                "success"
              );
            }
          }
        } catch (validationError) {
          console.warn(
            "Pre-sync validation failed, continuing with sync:",
            validationError
          );
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

      // REMOVED RETRY LOGIC - Let scheduled sync handle retries
      // If this is a scheduled sync, it will retry at the next scheduled time
      // If this is a manual sync, user can click "Sync Now" again

      if (showDownloadToast || !silent) {
        this.showDownloadToast(
          `❌ Upload failed: ${error.message}`,
          "error"
        );
      }

      return {
        success: false,
        message: error.message,
        willRetryAtScheduledTime: true
      };
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

      // REMOVED RETRY LOGIC - Let scheduled sync handle retries

      if (showDownloadToast || !silent) {
        this.showDownloadToast(
          `❌ Summary upload failed: ${error.message}`,
          "error"
        );
      }

      // Set pending summary sync flag for later retry
      this.pendingSummarySync = true;

      return {
        success: false,
        message: error.message,
        willRetryAtScheduledTime: true
      };
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
          `Retrying summary sync in ${this.summarySyncSettings.retryDelay / 1000
          } seconds... (attempt ${retryCount + 1}/${this.summarySyncSettings.retryAttempts
          })`
        );

        setTimeout(() => {
          this.performSummarySync(silent, retryCount + 1, showDownloadToast);
        }, this.summarySyncSettings.retryDelay);

        if (showDownloadToast || !silent) {
          this.showDownloadToast(
            `⚠️ Summary upload failed, retrying... (${retryCount + 1}/${this.summarySyncSettings.retryAttempts
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

    // Generate descriptors for all profiles in background
    setTimeout(() => {
      this.generateDescriptorsForAllProfiles().then(result => {
        if (result && result.success) {
          console.log(`Generated ${result.generated} face descriptors`);
        }
      });
    }, 2000); // Wait 2 seconds after sync to avoid blocking

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
      if (baseUrl.endsWith("/api/employees")) {
        baseUrl = baseUrl.replace("/api/employees", "");
      }

      const fullServerUrl = `${baseUrl}/api/employees`;

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

      const faceRecognitionEnabled = document.getElementById("faceRecognitionToggle")?.checked || false;

      const settings = {
        server_url: fullServerUrl,
        sync_interval: (Number.parseInt(syncIntervalInput) * 60000).toString(),
        summary_sync_interval: (
          Number.parseInt(summarySyncIntervalInput) * 60000
        ).toString(),
        grace_period: gracePeriodInput,
        face_detection_enabled: faceRecognitionEnabled.toString(), // ADD THIS LINE
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
        rebuildSummary: true,
        apply8HourRule: true
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
          this.showDownloadToast(
            "✅ Attendance validation completed",
            "success"
          );
        }
      } else {
        // Log warning but don't stop the sync process
        console.warn(
          "Attendance validation had issues:",
          validationResult.error
        );
        this.showDownloadToast(
          "⚠️ Validation completed with warnings",
          "warning"
        );
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
    const barcodeInput = document.getElementById("barcodeInput");
    const manualSubmit = document.getElementById("manualSubmit");
    const settingsBtn = document.getElementById("settingsBtn");
    const closeSettings = document.getElementById("closeSettings");
    const cancelSettings = document.getElementById("cancelSettings");
    const settingsModal = document.getElementById("settingsModal");
    const settingsForm = document.getElementById("settingsForm");
    const syncNowBtn = document.getElementById("syncNowBtn");

    let scanCooldown = false;
    const SCAN_COOLDOWN_MS = 1000; // 1 second cooldown between scans

    // OPTIMIZED: Immediate keypress handling
    barcodeInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();

        if (!scanCooldown) {
          scanCooldown = true;
          this.handleScan();

          setTimeout(() => {
            scanCooldown = false;
          }, SCAN_COOLDOWN_MS);
        }
      }
    });

    // OPTIMIZED: Faster barcode detection with reduced timeout
    barcodeInput.addEventListener("input", (e) => {
      const inputType = document.querySelector(
        'input[name="inputType"]:checked'
      ).value;

      if (this.barcodeTimeout) {
        clearTimeout(this.barcodeTimeout);
      }

      if (inputType === "barcode") {
        // OPTIMIZED: Reduced timeout from 2000ms to 500ms for faster auto-scan
        this.barcodeTimeout = setTimeout(() => {
          const currentValue = e.target.value.trim();
          if (currentValue.length >= 8 && !scanCooldown) {
            scanCooldown = true;
            this.handleScan();

            setTimeout(() => {
              scanCooldown = false;
            }, SCAN_COOLDOWN_MS);
          }
        }, 500);
      }
    });

    // OPTIMIZED: Handle paste events immediately
    barcodeInput.addEventListener("paste", (e) => {
      const inputType = document.querySelector(
        'input[name="inputType"]:checked'
      ).value;

      if (inputType === "barcode") {
        setTimeout(() => {
          const pastedValue = e.target.value.trim();
          if (pastedValue.length >= 8 && !scanCooldown) {
            scanCooldown = true;
            this.handleScan();

            setTimeout(() => {
              scanCooldown = false;
            }, SCAN_COOLDOWN_MS);
          }
        }, 100); // Reduced from 2000ms to 100ms
      }
    });

    manualSubmit.addEventListener("click", () => { });

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

    const downloadBtn = document.getElementById("downloadExcelBtn");
    if (downloadBtn) {
      downloadBtn.addEventListener("click", () => this.downloadExcel());
    }

    const syncAttendanceBtn = document.getElementById("syncAttendanceBtn");
    if (syncAttendanceBtn) {
      syncAttendanceBtn.addEventListener("click", () => {
        this.performAttendanceSync(false, 0, true); // Not silent, with download toast
      });
    }

    const clearCacheBtn = document.getElementById("clearCacheBtn");
    if (clearCacheBtn) {
      clearCacheBtn.addEventListener("click", () => {
        this.clearAllCaches();
      });
    }

    // Add cache stats display button if it exists
    const showCacheStatsBtn = document.getElementById("showCacheStatsBtn");
    if (showCacheStatsBtn) {
      showCacheStatsBtn.addEventListener("click", async () => {
        const stats = await this.getCacheStatistics();
        if (stats) {
          console.table(stats);
          this.showStatus(
            `Cache Stats - Profiles: ${stats.combined.totalProfiles}, Images: ${stats.combined.totalImages}`,
            "info"
          );
        }
      });
    }

    const faceRecognitionBtn = document.getElementById('openFaceRecognition');
    if (faceRecognitionBtn) {
      faceRecognitionBtn.addEventListener('click', () => {
        if (this.faceRecognitionManager) {
          this.faceRecognitionManager.show();
        }
      });
    }
  }

  showStatus(message, type = "info") {
    // Use a more lightweight status system for rapid operations
    let rapidStatus = document.getElementById("rapidStatus");

    if (!rapidStatus) {
      rapidStatus = document.createElement("div");
      rapidStatus.id = "rapidStatus";
      rapidStatus.className = "rapid-status";
      rapidStatus.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 8px 16px;
      border-radius: 4px;
      color: white;
      font-weight: bold;
      z-index: 10000;
      transition: all 0.2s ease;
      transform: translateX(100%);
    `;
      document.body.appendChild(rapidStatus);
    }

    rapidStatus.textContent = message;
    rapidStatus.className = `rapid-status ${type}`;

    // Set background color based on type
    const colors = {
      success: "#22c55e",
      error: "#ef4444",
      warning: "#f59e0b",
      info: "#3b82f6",
    };
    rapidStatus.style.backgroundColor = colors[type] || colors.info;

    // Show with animation
    rapidStatus.style.transform = "translateX(0)";

    // Auto-hide quickly
    setTimeout(() => {
      rapidStatus.style.transform = "translateX(100%)";
    }, 1500);
  }

  showEmployeeDisplay(data) {
    const {
      employee,
      clockType,
      sessionType,
      clockTime,
      regularHours,
      overtimeHours,
      isOvertimeSession,
    } = data;

    // Update the inline dashboard employee details section
    const dashboardEmployeeCard = document.getElementById("dashboardEmployeeCard");


    if (!dashboardEmployeeCard) {
      console.warn("Dashboard employee card not found");
      return;
    }

    // ⭐ Store the currently displayed employee UID
    dashboardEmployeeCard.dataset.employeeUid = employee.uid;

    setTimeout(() => {
      dashboardEmployeeCard.classList.add("show");
    }, 10);
    // Update employee photo
    const photo = document.getElementById("dashboardEmployeePhoto");
    if (photo) {
      photo.src = this.getDefaultImageDataURL();
      this.setupImageWithFallback(
        photo,
        employee.uid,
        `${employee.first_name} ${employee.last_name}`
      ).catch((error) => {
        console.warn(`Employee photo setup failed:`, error);
      });
    }

    // Update employee name
    const nameElement = document.getElementById("dashboardEmployeeName");
    if (nameElement) {
      nameElement.textContent = `${employee.first_name} ${employee.middle_name || ""} ${employee.last_name}`.trim();
    }

    // Update department
    const deptElement = document.getElementById("dashboardEmployeeDept");
    if (deptElement) {
      deptElement.textContent = employee.department || "No Department";
    }

    // Update ID number
    const idElement = document.getElementById("dashboardEmployeeId");
    if (idElement) {
      idElement.textContent = `ID: ${employee.id_number}`;
    }

    // Update clock type badge
    const clockTypeElement = document.getElementById("dashboardClockType");
    if (clockTypeElement) {
      clockTypeElement.textContent = this.formatClockType(clockType, sessionType);
      clockTypeElement.className = `clock-badge ${clockType.includes("in") ? "in" : "out"} ${isOvertimeSession ? "overtime" : ""
        }`;
    }

    // Update clock time
    const clockTimeElement = document.getElementById("dashboardClockTime");
    if (clockTimeElement) {
      clockTimeElement.textContent = new Date(clockTime).toLocaleTimeString();
    }

    // Update hours breakdown
    const hoursElement = document.getElementById("dashboardHours");
    const totalHours = (regularHours || 0) + (overtimeHours || 0);

    if (hoursElement) {
      if (isOvertimeSession) {
        hoursElement.innerHTML = `
          <div class="hours-row">
            <span class="hours-label">Regular:</span>
            <span class="hours-value">${regularHours || 0}h</span>
          </div>
          <div class="hours-row">
            <span class="hours-label">Overtime:</span>
            <span class="hours-value overtime">${overtimeHours || 0}h</span>
          </div>
          <div class="hours-row total">
            <span class="hours-label">Total:</span>
            <span class="hours-value">${totalHours.toFixed(2)}h</span>
          </div>
          <div class="session-indicator overtime">🌙 ${sessionType || "Overtime Session"}</div>
        `;
      } else {
        hoursElement.innerHTML = `
          <div class="hours-row">
            <span class="hours-label">Regular:</span>
            <span class="hours-value">${regularHours || 0}h</span>
          </div>
          <div class="hours-row">
            <span class="hours-label">Overtime:</span>
            <span class="hours-value">${overtimeHours.toFixed(2)}h</span>
          </div>
          <div class="hours-row total">
            <span class="hours-label">Total:</span>
            <span class="hours-value">${totalHours.toFixed(2)}h</span>
          </div>
        `;
      }
    }

    // Brief highlight animation
    dashboardEmployeeCard.classList.add("highlight");
    setTimeout(() => {
      dashboardEmployeeCard.classList.remove("highlight");
    }, 1000);

    // Show success status
    this.showStatus("✓ Attendance Recorded", "success");

    // Keep card visible - no auto-hide
    // The card will stay visible showing the last scanned employee

    // Focus input immediately for next scan
    this.focusInput();

    // Handle input type changes
    const inputTypeRadios = document.querySelectorAll('input[name="inputType"]');
    inputTypeRadios.forEach((radio) => {
      radio.addEventListener("change", () => {
        this.focusInput();
        if (this.barcodeTimeout) {
          clearTimeout(this.barcodeTimeout);
        }
      });
    });

    // Listen for IPC events from main process using the exposed API
    if (this.electronAPI) {
      this.electronAPI.onSyncAttendanceToServer(() => {
        this.performAttendanceSync(false, 0, true);
      });
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

      console.log("Employee sync result:", result);

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

  /**
   * Update openSettings() to load server edit sync info
   */
  openSettings() {
    const modal = document.getElementById('settingsModal');
    modal.classList.add('show');
    this.loadSettings();
    this.loadSyncInfo();
    this.loadSummaryInfo();
    this.loadAttendanceSyncInfo();
    this.loadServerEditSyncInfo(); // ADD THIS LINE
    this.loadDailySummary();
    this.initializeSettingsTabs();

    // Setup server edit sync UI if not already done
    if (!document.getElementById('serverEditSyncInfo')?.hasChildNodes()) {
      this.setupServerEditSyncUI();
    }
  }

  /**
   * KEEP: destroy method but remove auto-sync cleanup
   */
  destroy() {
    super.destroy();

    // Remove server edit sync listener
    if (this.electronAPI && this.electronAPI.removeServerEditsListener) {
      this.electronAPI.removeServerEditsListener();
    }

    // No need to stop auto-sync timer since we don't have one
    console.log('Server edit sync listener removed');
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
      document.getElementById("summarySyncInterval").value = "10";
      document.getElementById("faceRecognitionToggle").checked = true; // Demo face recognition enabled
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
        document.getElementById("summarySyncInterval").value = Math.floor(
          (settings.summary_sync_interval || 600000) / 60000
        );

        // Load face recognition setting
        const faceRecognitionEnabled = settings.face_detection_enabled === "true" || settings.face_detection_enabled === true;
        document.getElementById("faceRecognitionToggle").checked = faceRecognitionEnabled;
        console.log("Face Recognition loaded:", faceRecognitionEnabled);
      }
    } catch (error) {
      console.error("Error loading settings:", error);
      this.showSettingsStatus("Error loading settings", "error");
    }
  }

  // PERFORMANCE: Enhanced sync info with cache stats
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

        const employeeUids = employeesResult.data.map((emp) => emp.uid);
        const profileResult = await this.electronAPI.checkProfileImages(
          employeeUids
        );

        if (profileResult.success) {
          document.getElementById(
            "profileStatus"
          ).textContent = `Profile images: ${profileResult.downloaded}/${profileResult.total} downloaded`;
        } else {
          document.getElementById("profileStatus").textContent =
            "Profile images: Error checking profiles";
        }

        // PERFORMANCE: Add cache statistics to sync info
        const cacheStats = await this.getCacheStatistics();
        if (cacheStats) {
          const cacheInfoElement = document.getElementById("cacheInfo");
          if (!cacheInfoElement) {
            // Create cache info element if it doesn't exist
            const syncInfoDiv = document.getElementById("syncInfo");
            const cacheDiv = document.createElement("div");
            cacheDiv.id = "cacheInfo";
            cacheDiv.innerHTML = `
              <div class="sync-info-item">
                <strong>Cache Performance:</strong>
                <div class="cache-stats">
                  <span>Profiles: ${cacheStats.combined.totalProfiles} cached</span> |
                  <span>Images: ${cacheStats.combined.totalImages} cached</span> |
                  <span>Preloaded: ${cacheStats.renderer.preloadedProfiles} ready</span>
                </div>
              </div>
            `;
            syncInfoDiv.appendChild(cacheDiv);
          } else {
            cacheInfoElement.querySelector(".cache-stats").innerHTML = `
              <span>Profiles: ${cacheStats.combined.totalProfiles} cached</span> |
              <span>Images: ${cacheStats.combined.totalImages} cached</span> |
              <span>Preloaded: ${cacheStats.renderer.preloadedProfiles} ready</span>
            `;
          }
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
            <strong>Unsynced Summary Records:</strong> ${unsyncedResult.success ? unsyncedResult.count : 0
          }
          </div>
          <div class="sync-info-item">
            <strong>Summary Auto-sync:</strong> ${syncStatus}
          </div>
          <div class="sync-info-item">
            <strong>Last Summary Sync:</strong> ${lastSyncText}
          </div>
          <div class="sync-info-item">
            <strong>Pending Sync:</strong> ${this.pendingSummarySync ? "Yes" : "No"
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
          <strong>Scheduled Sync:</strong> 08:30, 12:30, 13:30, 17:30
        </div>
        <div class="sync-info-item">
          <strong>Next Sync:</strong> Calculating... (Demo)
        </div>
      `;
      }
      return;
    }

    try {
      const unsyncedResult = await this.electronAPI.getUnsyncedAttendanceCount();
      const attendanceSyncInfo = document.getElementById("attendanceSyncInfo");

      if (attendanceSyncInfo && unsyncedResult.success) {
        // Format schedule times
        const scheduleTimes = this.attendanceSyncSchedule.map(s =>
          `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`
        ).join(', ');

        const nextSync = this.getNextScheduledSyncTime();
        const summaryCount = await this.electronAPI.getUnsyncedDailySummaryCount();

        attendanceSyncInfo.innerHTML = `
    <div class="sync-info-item">
      <strong>Unsynced Attendance:</strong> ${unsyncedResult.count}
    </div>
    <div class="sync-info-item">
      <strong>Unsynced Summary:</strong> ${summaryCount.count || 0}
    </div>
    <div class="sync-info-item">
      <strong>Sync Schedule:</strong> ${scheduleTimes} (daily)
      <br><small>Syncs both attendance and summary together</small>
    </div>
    <div class="sync-info-item">
      <strong>Next Sync:</strong> ${nextSync}
    </div>
  `;
      }
    } catch (error) {
      console.error("Error loading attendance sync info:", error);
    }
  }

  // Helper method to calculate next scheduled sync time
  getNextScheduledSyncTime() {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    for (const schedule of this.attendanceSyncSchedule) {
      const scheduleMinutes = schedule.hour * 60 + schedule.minute;

      if (scheduleMinutes > currentMinutes) {
        return `Today at ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
      }
    }

    // If all times passed today, show first time tomorrow
    const firstSchedule = this.attendanceSyncSchedule[0];
    return `Tomorrow at ${String(firstSchedule.hour).padStart(2, '0')}:${String(firstSchedule.minute).padStart(2, '0')}`;
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
    // Clear any pending timeouts immediately
    if (this.barcodeTimeout) {
      clearTimeout(this.barcodeTimeout);
    }

    const input = document.getElementById("barcodeInput").value.trim();
    const inputType = document.querySelector(
      'input[name="inputType"]:checked'
    ).value;

    if (!input) {
      this.showStatus("Please enter a barcode or ID number", "error");
      this.focusInput();
      return;
    }

    // OPTIMIZED: Reduced duplicate prevention window for faster scanning
    const currentTime = Date.now();
    const timeDifference = currentTime - this.lastScanData.timestamp;
    const duplicateWindow = 3000; // Reduced from 60000ms to 3000ms (3 seconds)

    if (this.lastScanData.input === input && timeDifference < duplicateWindow) {
      console.log(
        `Duplicate scan blocked: "${input}" (${timeDifference}ms ago)`
      );
      this.clearInput(); // Clear input immediately for next scan
      return; // Silent return - no status message for faster UX
    }

    // Update scan tracking immediately
    this.lastScanData.input = input;
    this.lastScanData.timestamp = currentTime;

    // OPTIMIZED: Skip loading screen for rapid scanning
    const shouldShowLoading = timeDifference > 5000; // Only show loading if last scan was >5s ago

    // Get UI elements once
    const barcodeInput = document.getElementById("barcodeInput");
    const submitButton = document.getElementById("manualSubmit");
    const originalText = submitButton.textContent;

    // OPTIMIZED: Minimal UI updates during rapid scanning
    barcodeInput.disabled = true;
    submitButton.textContent = "⚡";
    submitButton.disabled = true;

    if (shouldShowLoading) {
      this.showLoadingScreen();
    }

    try {
      // OPTIMIZED: Use Promise.race to timeout long operations
      const clockPromise = this.electronAPI.clockAttendance({
        input: input,
        inputType: inputType,
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Operation timeout")), 8000)
      );

      const result = await Promise.race([clockPromise, timeoutPromise]);

      if (result.success) {
        if (shouldShowLoading) {
          // Minimal loading time for rapid scans
          await new Promise((resolve) => setTimeout(resolve, 100));
          this.hideLoadingScreen();
        }

        // OPTIMIZED: Immediate feedback without blocking
        this.showEmployeeDisplay(result.data);
        this.clearInput();
        this.showStatus("✓ Recorded", "success");

        // OPTIMIZED: Defer heavy operations
        this.deferredOperations(result.data);
      } else {
        if (shouldShowLoading) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          this.hideLoadingScreen();
        }

        this.showStatus(result.error || "Employee not found", "error");
        this.focusInput();
      }
    } catch (error) {
      console.error("Clock error:", error);

      if (shouldShowLoading) {
        this.hideLoadingScreen();
      }

      if (error.message === "Operation timeout") {
        this.showStatus("Operation timed out - try again", "warning");
      } else {
        this.showStatus("System error", "error");
      }

      this.focusInput();
    } finally {
      // OPTIMIZED: Immediate UI restoration
      barcodeInput.disabled = false;
      submitButton.textContent = originalText;
      submitButton.disabled = false;

      // Focus input immediately for next scan
      setTimeout(() => this.focusInput(), 50);
    }
  }

  deferredOperations(data) {
    // Queue these operations to run after a short delay
    setTimeout(() => {
      this.loadTodayAttendance();
      this.markSummaryDataChanged();
      this.markAttendanceForSync(); // NEW: Mark for scheduled sync instead of immediate sync
    }, 1000);
  }

  // Generate a loading image as data URL
  getLoadingImageDataURL() {
    return "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgZmlsbD0iI2Y4ZjhmOCIgcng9IjUwIi8+PGNpcmNsZSBjeD0iNTAiIGN5PSI1MCIgcj0iMTUiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzAwN2NmZiIgc3Ryb2tlLXdpZHRoPSIzIiBzdHJva2UtZGFzaGFycmF5PSI4IDQiPjxhbmltYXRlVHJhbnNmb3JtIGF0dHJpYnV0ZU5hbWU9InRyYW5zZm9ybSIgYXR0cmlidXRlVHlwZT0iWE1MIiB0eXBlPSJyb3RhdGUiIGZyb209IjAgNTAgNTAiIHRvPSIzNjAgNTAgNTAiIGR1cj0iMXMiIHJlcGVhdENvdW50PSJpbmRlZmluaXRlIi8+PC9jaXJjbGU+PC9zdmc+";
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

  // PERFORMANCE: Enhanced loadInitialData with cache preloading
  async loadInitialData() {
    this.showDownloadToast("🔄 Loading initial data...", "info");

    try {
      // Validate attendance data first
      await this.validateAttendanceData();

      // Load regular data with cache optimization
      await Promise.all([
        this.loadTodayAttendance(),
        this.syncEmployees(),
        this.preloadSessionData(), // New: preload common scanning session data
      ]);

      this.showDownloadToast("✅ Initial data loaded successfully!", "success");
    } catch (error) {
      console.error("Error loading initial data:", error);
      this.showDownloadToast("❌ Failed to load initial data", "error");
    }
  }

  // PERFORMANCE: Preload common scanning session data
  async preloadSessionData() {
    if (!this.electronAPI) return;

    try {
      // Get today's attendance to predict likely next scans
      const todayResult = await this.electronAPI.getTodayAttendance();
      if (todayResult.success && todayResult.data.currentlyClocked) {
        // Preload profiles for currently clocked employees (likely to clock out)
        const currentlyClocked = todayResult.data.currentlyClocked;
        const clockedBarcodes = currentlyClocked.map((emp) => emp.employee_uid);

        if (clockedBarcodes.length > 0) {
          console.log(
            `Preloading ${clockedBarcodes.length} currently clocked employee profiles...`
          );
          const preloadResult = await this.electronAPI.preloadScanningSession(
            clockedBarcodes
          );

          if (preloadResult.success) {
            clockedBarcodes.forEach((barcode) =>
              this.preloadedProfiles.add(barcode)
            );
            console.log(
              `✓ Preloaded currently clocked: ${preloadResult.preloaded}/${preloadResult.total}`
            );
          }
        }
      }
    } catch (error) {
      console.warn("Session data preloading warning:", error);
    }
  }

  // PERFORMANCE: Clear caches when needed
  async clearAllCaches() {
    try {
      // Clear renderer caches
      this.profileCache.clear();
      this.imageCache.clear();
      this.preloadedProfiles.clear();

      // Clear main process caches
      if (this.electronAPI) {
        const result = await this.electronAPI.clearProfileCache();
        if (result.success) {
          console.log("✓ All caches cleared successfully");
          this.showStatus("Caches cleared successfully", "success");
        }
      }
    } catch (error) {
      console.error("Error clearing caches:", error);
      this.showStatus("Error clearing caches", "error");
    }
  }

  // PERFORMANCE: Get cache statistics for display
  async getCacheStatistics() {
    try {
      const mainStats = await this.electronAPI.getCacheStats();

      return {
        mainProcess: mainStats.success ? mainStats.data : null,
        renderer: {
          profileCache: this.profileCache.size,
          imageCache: this.imageCache.size,
          preloadedProfiles: this.preloadedProfiles.size,
        },
        combined: {
          totalProfiles:
            (mainStats.success ? mainStats.data.profileCache.size : 0) +
            this.profileCache.size,
          totalImages:
            (mainStats.success ? mainStats.data.imageCache.size : 0) +
            this.imageCache.size,
        },
      };
    } catch (error) {
      console.error("Error getting cache statistics:", error);
      return null;
    }
  }

  // New method to validate attendance data
  async validateAttendanceData() {
    if (!this.electronAPI) {
      console.log("Demo mode: Skipping attendance validation");
      return { success: true, message: "Demo mode - validation skipped" };
    }

    try {
      this.showDownloadToast(
        "🔍 Validating attendance calculations...",
        "info"
      );

      // Validate today's attendance data
      const today = new Date().toISOString().split("T")[0];

      // Get validation result from the main process
      const validationResult = await this.electronAPI.validateAttendanceData({
        startDate: today,
        endDate: today,
        autoCorrect: true,
        updateSyncStatus: true,
        validateStatistics: true,
        rebuildSummary: false,
        apply8HourRule: true
      });

      if (validationResult.success && validationResult.data) {
        // The data structure from AttendanceValidationService.validationResults
        const validationData = validationResult.data;

        // Check if we have the expected structure
        if (validationData.totalRecords !== undefined) {
          const correctedRecords = validationData.correctedRecords || 0;
          const totalRecords = validationData.totalRecords || 0;

          if (correctedRecords > 0) {
            console.log(
              `Validation completed: ${correctedRecords} records corrected out of ${totalRecords} total`
            );
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
            console.log(
              `Validation completed: All ${totalRecords} records are accurate`
            );
            this.showDownloadToast(
              `✅ All ${totalRecords} attendance records validated`,
              "success"
            );
          }
        } else {
          // Fallback if structure is different
          console.log(
            "Validation completed with unknown result structure:",
            validationData
          );
          this.showDownloadToast(
            "✅ Attendance validation completed",
            "success"
          );
        }

        return validationResult;
      } else {
        const errorMessage =
          validationResult.error || "Unknown validation error";
        console.warn("Attendance validation failed:", errorMessage);
        this.showDownloadToast(
          "⚠️ Attendance validation encountered issues",
          "warning"
        );
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

        // ⭐ Update the dashboard employee card with the most recent clock event
        if (result.data.attendance && result.data.attendance.length > 0) {
          const latestAttendance = result.data.attendance[0]; // Most recent is first

          // Check if this is a different employee than currently displayed
          const currentDisplayUID = document.getElementById('dashboardEmployeeCard')?.dataset?.employeeUid;

          if (currentDisplayUID !== latestAttendance.employee_uid) {
            console.log('Updating dashboard with latest attendance:', latestAttendance.first_name, latestAttendance.last_name);

            // Construct data in the format showEmployeeDisplay expects
            const displayData = {
              employee: {
                uid: latestAttendance.employee_uid,
                first_name: latestAttendance.first_name,
                middle_name: latestAttendance.middle_name || '',
                last_name: latestAttendance.last_name,
                department: latestAttendance.department,
                id_number: latestAttendance.id_number
              },
              clockType: latestAttendance.clock_type,
              sessionType: latestAttendance.session_type,
              clockTime: latestAttendance.clock_time,
              regularHours: latestAttendance.regular_hours || 0,
              overtimeHours: latestAttendance.overtime_hours || 0,
              isOvertimeSession: latestAttendance.is_overtime_session || false
            };

            this.showEmployeeDisplay(displayData);
          }
        }
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
          <td><span class="status-badge ${status.class}">${status.text
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
      const summaryData = this.summaryData;

      if (!summaryData || summaryData.length === 0) {
        this.showStatus("No data available for export", "error");
        return;
      }

      const workbook = XLSX.utils.book_new();

      // Helper function to format time only
      const formatTimeOnly = (datetime) => {
        if (!datetime) return "";
        try {
          return this.formatDateTime(datetime);
        } catch {
          return "";
        }
      };

      // Helper function to check if date is Sunday and calculate total hours
      const getSundayHours = (dateStr, regularHours, overtimeHours) => {
        const date = new Date(dateStr);
        const dayOfWeek = date.getDay();

        if (dayOfWeek === 0) { // Sunday
          const totalHours = (regularHours || 0) + (overtimeHours || 0);
          return totalHours > 0 ? totalHours.toFixed(1) : "";
        }
        return "";
      };

      // Helper function to generate intelligent remarks
      const generateRemarks = (summary) => {
        const remarks = [];

        // Check for clock records existence
        const hasAnyClockIn = summary.morning_in || summary.afternoon_in || summary.evening_in;
        const hasAnyClockOut = summary.morning_out || summary.afternoon_out || summary.evening_out;

        // Check for perfect attendance first - if perfect, return empty
        if (summary.total_hours >= 8 && !summary.has_late_entry && hasAnyClockIn && hasAnyClockOut) {
          return ""; // Perfect attendance = no remarks
        }

        // Check specific incomplete cycles
        const missingOuts = [];
        if (summary.morning_in && !summary.morning_out) {
          missingOuts.push("Morning Out");
        }
        if (summary.afternoon_in && !summary.afternoon_out) {
          missingOuts.push("Afternoon Out");
        }
        if (summary.evening_in && !summary.evening_out) {
          missingOuts.push("Overtime Out");
        }

        const missingIns = [];
        if (!summary.morning_in && summary.morning_out) {
          missingIns.push("Morning In");
        }
        if (!summary.afternoon_in && summary.afternoon_out) {
          missingIns.push("Afternoon In");
        }
        if (!summary.evening_in && summary.evening_out) {
          missingIns.push("Overtime In");
        }

        // Add specific missing clock out remarks
        if (missingOuts.length > 0) {
          remarks.push("INCOMPLETE - Missing " + missingOuts.join(", "));
        }

        // Add specific missing clock in remarks
        if (missingIns.length > 0) {
          remarks.push("INCOMPLETE - Missing " + missingIns.join(", "));
        }

        // Check for late entry
        if (summary.has_late_entry) {
          remarks.push("LATE ARRIVAL");
        }

        // Check for overtime without regular hours
        if ((summary.overtime_hours > 0) && (summary.regular_hours === 0 || !summary.regular_hours)) {
          remarks.push("OT WITHOUT REG HOURS");
        }

        // Check for excessive overtime
        if (summary.overtime_hours > 4) {
          remarks.push("EXCESSIVE OT (" + summary.overtime_hours.toFixed(1) + "h)");
        }

        // Check for minimal hours
        if (summary.total_hours > 0 && summary.total_hours < 4) {
          remarks.push("MINIMAL HOURS (" + summary.total_hours.toFixed(1) + "h)");
        }

        // Check for weekend work
        const date = new Date(summary.date);
        const dayOfWeek = date.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) { // Sunday or Saturday
          remarks.push("WEEKEND WORK");
        }

        // Check for no activity
        if (!hasAnyClockIn && !hasAnyClockOut && (summary.total_hours === 0 || !summary.total_hours)) {
          remarks.push("NO ACTIVITY");
        }

        return remarks.length > 0 ? remarks.join("; ") : "";
      };

      const employeeSummaryHeaders = [
        "EMPLOYEE_NAME", "DATE_OF_LOG", "MORNING_IN", "MORNING_OUT",
        "AFTERNOON_IN", "AFTERNOON_OUT", "OVERTIME_IN", "OVERTIME_OUT",
        "REG HRS", "OT HRS", "SUNDAY", "REMARKS"
      ];

      const employeeSummaryData = [];

      // Sort by last_name, then first_name, then date
      const sortedData = summaryData.sort((a, b) => {
        const lastNameComparison = (a.last_name || "").localeCompare(b.last_name || "");
        if (lastNameComparison !== 0) return lastNameComparison;

        const firstNameComparison = (a.first_name || "").localeCompare(b.first_name || "");
        if (firstNameComparison !== 0) return firstNameComparison;

        return new Date(a.date) - new Date(b.date);
      });

      // Group by both last_name and first_name
      const groupedByEmployee = {};
      sortedData.forEach((summary) => {
        const key = `${summary.last_name || "Unknown"}, ${summary.first_name || "Unknown"}`;
        if (!groupedByEmployee[key]) {
          groupedByEmployee[key] = [];
        }
        groupedByEmployee[key].push(summary);
      });

      // Track totals
      let grandTotalRegularHours = 0;
      let grandTotalOvertimeHours = 0;
      let grandTotalSundayHours = 0;
      let totalLateCount = 0;
      let totalIncompleteCount = 0;
      let totalPerfectAttendanceCount = 0;

      // Process each employee group
      Object.keys(groupedByEmployee).sort().forEach((employeeKey, groupIndex) => {
        const employeeRecords = groupedByEmployee[employeeKey];

        // Add empty row before new employee section (except for first employee)
        if (groupIndex > 0) {
          employeeSummaryData.push(["", "", "", "", "", "", "", "", "", "", "", ""]);
        }

        // Add the header row for this employee section
        employeeSummaryData.push([
          "EMPLOYEE_NAME", "DATE_OF_LOG", "MORNING_IN", "MORNING_OUT",
          "AFTERNOON_IN", "AFTERNOON_OUT", "OVERTIME_IN", "OVERTIME_OUT",
          "REG HRS", "OT HRS", "SUNDAY", "REMARKS"
        ]);

        let subtotalRegularHours = 0;
        let subtotalOvertimeHours = 0;
        let subtotalSundayHours = 0;
        let employeeLateCount = 0;
        let employeeIncompleteCount = 0;
        let employeePerfectCount = 0;

        // Add employee records
        employeeRecords.forEach((summary) => {
          const employeeName = summary.employee_name ||
            `${summary.first_name || ""} ${summary.last_name || ""}`.trim() ||
            "Unknown";

          const sundayHours = getSundayHours(summary.date, summary.regular_hours, summary.overtime_hours);
          const regularHours = summary.regular_hours || 0;
          const overtimeHours = summary.overtime_hours || 0;
          const remarks = generateRemarks(summary);

          // Track statistics
          subtotalRegularHours += regularHours;
          subtotalOvertimeHours += overtimeHours;
          if (sundayHours) {
            subtotalSundayHours += parseFloat(sundayHours);
          }
          if (summary.has_late_entry) employeeLateCount++;
          if (remarks.includes("INCOMPLETE")) employeeIncompleteCount++;
          if (!remarks || remarks === "") employeePerfectCount++;

          employeeSummaryData.push([
            employeeName,
            summary.date,
            formatTimeOnly(summary.morning_in),
            formatTimeOnly(summary.morning_out),
            formatTimeOnly(summary.afternoon_in),
            formatTimeOnly(summary.afternoon_out),
            formatTimeOnly(summary.evening_in || summary.overtime_in),
            formatTimeOnly(summary.evening_out || summary.overtime_out),
            regularHours.toFixed(1),
            overtimeHours.toFixed(1),
            sundayHours,
            remarks
          ]);
        });

        // Add employee summary row
        employeeSummaryData.push([
          "", "", "", "", "", "", "",
          "TOTAL HOURS",
          subtotalRegularHours.toFixed(1),
          subtotalOvertimeHours.toFixed(1),
          subtotalSundayHours > 0 ? subtotalSundayHours.toFixed(1) : "",
          `Late: ${employeeLateCount} | Inc: ${employeeIncompleteCount} | Perfect: ${employeePerfectCount}`
        ]);

        // Add to grand totals
        grandTotalRegularHours += subtotalRegularHours;
        grandTotalOvertimeHours += subtotalOvertimeHours;
        grandTotalSundayHours += subtotalSundayHours;
        totalLateCount += employeeLateCount;
        totalIncompleteCount += employeeIncompleteCount;
        totalPerfectAttendanceCount += employeePerfectCount;
      });

      // Add final totals
      employeeSummaryData.push(["", "", "", "", "", "", "", "", "", "", "", ""]);
      employeeSummaryData.push([
        "", "", "", "", "", "", "",
        "GRAND TOTALS",
        grandTotalRegularHours.toFixed(1),
        grandTotalOvertimeHours.toFixed(1),
        grandTotalSundayHours > 0 ? grandTotalSundayHours.toFixed(1) : "",
        `Late: ${totalLateCount} | Inc: ${totalIncompleteCount} | Perfect: ${totalPerfectAttendanceCount}`
      ]);

      const employeeSummarySheet = XLSX.utils.aoa_to_sheet(employeeSummaryData);

      // Enhanced styling for employee summary
      const empRange = XLSX.utils.decode_range(employeeSummarySheet['!ref']);

      for (let R = empRange.s.r; R <= empRange.e.r; R++) {
        const cellA = XLSX.utils.encode_cell({ r: R, c: 0 });
        if (employeeSummarySheet[cellA] &&
          employeeSummarySheet[cellA].v === "EMPLOYEE_NAME") {

          // Style employee section header row
          for (let C = empRange.s.c; C <= empRange.e.c; C++) {
            const cellAddress = XLSX.utils.encode_cell({ r: R, c: C });
            if (employeeSummarySheet[cellAddress]) {
              employeeSummarySheet[cellAddress].s = {
                font: { bold: true, sz: 11, color: { rgb: "FFFFFF" } },
                fill: { fgColor: { rgb: "DC2626" } },
                alignment: { horizontal: "center", vertical: "center" },
                border: {
                  top: { style: "thin", color: { rgb: "000000" } },
                  bottom: { style: "thin", color: { rgb: "000000" } },
                  left: { style: "thin", color: { rgb: "000000" } },
                  right: { style: "thin", color: { rgb: "000000" } }
                }
              };
            }
          }
        }

        const cellH = XLSX.utils.encode_cell({ r: R, c: 7 });
        if (employeeSummarySheet[cellH] &&
          (employeeSummarySheet[cellH].v === "TOTAL HOURS" ||
            employeeSummarySheet[cellH].v === "GRAND TOTALS")) {

          // Style subtotal/total row
          for (let C = empRange.s.c; C <= empRange.e.c; C++) {
            const cellAddress = XLSX.utils.encode_cell({ r: R, c: C });
            if (employeeSummarySheet[cellAddress]) {
              employeeSummarySheet[cellAddress].s = {
                font: { bold: true, color: { rgb: "FFFFFF" } },
                fill: { fgColor: { rgb: "059669" } },
                alignment: { horizontal: "center" },
                border: {
                  top: { style: "thin", color: { rgb: "000000" } },
                  bottom: { style: "thin", color: { rgb: "000000" } },
                  left: { style: "thin", color: { rgb: "000000" } },
                  right: { style: "thin", color: { rgb: "000000" } }
                }
              };
            }
          }
        }
      }

      employeeSummarySheet["!cols"] = [
        { wch: 20 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
        { wch: 10 }, { wch: 10 }, { wch: 25 }, { wch: 10 }, { wch: 8 },
        { wch: 8 }, { wch: 40 }
      ];

      XLSX.utils.book_append_sheet(workbook, employeeSummarySheet, "Employee Summary");

      // Generate filename
      let filename = "Employee_Attendance_Summary";

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
      XLSX.writeFile(workbook, filename);

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
            <span class="session-count">${stats.sessionBreakdown.morning || 0
          }</span>
            <span class="session-label">Morning</span>
          </div>
          <div class="session-stat afternoon">
            <span class="session-count">${stats.sessionBreakdown.afternoon || 0
          }</span>
            <span class="session-label">Afternoon</span>
          </div>
          <div class="session-stat evening">
            <span class="session-count">${stats.sessionBreakdown.evening || 0
          }</span>
            <span class="session-label">Evening</span>
          </div>
          <div class="session-stat overtime">
            <span class="session-count">${stats.sessionBreakdown.overtime || 0
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
                     src="${this.getDefaultImageDataURL()}"
                     alt="${emp.first_name} ${emp.last_name}">
                <div class="employee-details">
                    <div class="employee-name">${emp.first_name} ${emp.last_name
          }</div>
                    <div class="employee-dept">${emp.department || "No Department"
          }</div>
                </div>
                <div class="clock-badge ${badgeClass}">
                    ${sessionIcon} ${sessionType}
                </div>
            </div>
        `;
      })
      .join("");

    // Load images asynchronously after DOM is updated
    setTimeout(() => {
      imageIds.forEach(({ id, uid, name }) => {
        const imgElement = document.getElementById(id);
        if (imgElement) {
          // Use the bound method
          this.setupImageWithFallback(imgElement, uid, name).catch((error) => {
            console.warn(`Image setup failed for ${uid}:`, error);
          });
        }
      });
    }, 10);
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
                     src="${this.getDefaultImageDataURL()}"
                     alt="${record.first_name} ${record.last_name}">
                <div class="attendance-details">
                    <div class="attendance-name">${record.first_name} ${record.last_name
          }</div>
                    <div class="attendance-time">${new Date(
            record.clock_time
          ).toLocaleTimeString()}</div>
                    ${isOvertime
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

    // Load images asynchronously after DOM is updated
    setTimeout(() => {
      imageIds.forEach(({ id, uid, name }) => {
        const imgElement = document.getElementById(id);
        if (imgElement) {
          // Use the bound method
          this.setupImageWithFallback(imgElement, uid, name).catch((error) => {
            console.warn(`Image setup failed for ${uid}:`, error);
          });
        }
      });
    }, 10);
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

  // Clean up performance monitoring
  destroy() {
    this.stopAutoSync();
    this.stopScheduledSync();
    this.stopFaceRecognitionScheduler();

    // PERFORMANCE: Clear cache monitoring
    if (this.cacheStatsInterval) {
      clearInterval(this.cacheStatsInterval);
      this.cacheStatsInterval = null;
    }

    // PERFORMANCE: Clear renderer caches
    this.profileCache.clear();
    this.imageCache.clear();
    this.preloadedProfiles.clear();

    if (this.employeeDisplayTimeout) {
      clearTimeout(this.employeeDisplayTimeout);
    }

    if (this.barcodeTimeout) {
      clearTimeout(this.barcodeTimeout);
    }

    if (this.ws) {
      this.ws.close();
    }

    this.imageLoadAttempts.clear();

    const downloadToast = document.getElementById("downloadToast");
    if (downloadToast && downloadToast.hideTimeout) {
      clearTimeout(downloadToast.hideTimeout);
    }

    console.log(
      "AttendanceApp destroyed and cleaned up with performance optimizations"
    );
  }

  // Add these methods to your AttendanceApp class

  /**
   * ENHANCED: Setup server edit sync UI with comparison feature
   */
  setupServerEditSyncUI() {
    const syncPanel = document.getElementById('syncPanel');

    if (!syncPanel) {
      console.warn('Sync panel not found, cannot setup server edit sync UI');
      return;
    }

    if (document.getElementById('serverEditSyncInfo')) {
      console.log('Server edit sync UI already setup');
      return;
    }

    const serverEditSection = document.createElement('div');
    serverEditSection.className = 'settings-section server-edit-sync-section';
    serverEditSection.innerHTML = `
    <h3>📝 Server Edit Sync with Comparison</h3>
    <p class="section-description">
      Compare server and local attendance records to identify differences, then apply selected actions.
      <br><strong>New:</strong> Review changes before applying them to your local database.
    </p>
    
    <!-- Comparison Tool -->
    <div class="comparison-tool" style="margin-top: 20px; padding: 15px; background: #f0f9ff; border: 1px solid #3b82f6; border-radius: 8px;">
      <h4 style="margin: 0 0 10px 0; color: #1e40af;">🔍 Compare Server vs Local Records</h4>
      <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 10px; margin-bottom: 10px;">
        <div>
          <label style="display: block; font-size: 12px; margin-bottom: 5px;">Start Date</label>
          <input type="date" id="compareStartDate" class="form-control" />
        </div>
        <div>
          <label style="display: block; font-size: 12px; margin-bottom: 5px;">End Date</label>
          <input type="date" id="compareEndDate" class="form-control" />
        </div>
        <div style="display: flex; align-items: flex-end;">
          <button id="compareServerLocalBtn" class="primary-button" style="width: 100%;">
            🔍 Compare
          </button>
        </div>
      </div>
      <div id="comparisonResults" style="display: none; margin-top: 15px;">
        <!-- Results will be inserted here -->
      </div>
    </div>

    <!-- Sync Info -->
    <div id="serverEditSyncInfo" class="sync-info" style="margin-top: 15px;">
      <div class="loading">Loading sync information...</div>
    </div>
    
    <!-- Action Buttons -->
    <div class="button-group" style="margin-top: 15px;">
      <button id="checkServerEditsNowBtn" class="primary-button">
        🔄 Check Server Edits Now
      </button>
      <button id="viewServerEditHistoryBtn" class="secondary-button">
        📊 View Sync History
      </button>
    </div>
    
    <div class="sync-info-item" style="margin-top: 10px; padding: 10px; background: #f0f9ff; border-left: 4px solid #3b82f6;">
      <strong>💡 How to use:</strong>
      <ul style="margin: 5px 0 0 20px; padding: 0;">
        <li><strong>Compare:</strong> Select date range and click "Compare" to see differences between server and local</li>
        <li><strong>Review:</strong> Examine server-only, local-only, different, and duplicate records</li>
        <li><strong>Select Actions:</strong> Choose which changes to apply (add, update, delete, or keep)</li>
        <li><strong>Apply:</strong> Click "Apply Selected Actions" to execute changes and rebuild summaries</li>
        <li><strong>Quick Sync:</strong> Use "Check Server Edits Now" for automatic sync without comparison</li>
      </ul>
    </div>
  `;

    const lastSection = syncPanel.querySelector('.settings-section:last-child');
    if (lastSection) {
      syncPanel.insertBefore(serverEditSection, lastSection);
    } else {
      syncPanel.appendChild(serverEditSection);
    }

    // Set default dates (last 7 days)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);

    document.getElementById('compareStartDate').value = startDate.toISOString().split('T')[0];
    document.getElementById('compareEndDate').value = endDate.toISOString().split('T')[0];

    // Add event listeners
    const compareBtn = document.getElementById('compareServerLocalBtn');
    const checkNowBtn = document.getElementById('checkServerEditsNowBtn');
    const viewHistoryBtn = document.getElementById('viewServerEditHistoryBtn');

    if (compareBtn) {
      compareBtn.addEventListener('click', async () => {
        await this.compareServerAndLocal();
      });
    }

    if (checkNowBtn) {
      checkNowBtn.addEventListener('click', async () => {
        checkNowBtn.disabled = true;
        checkNowBtn.textContent = '🔄 Checking...';

        try {
          await this.checkServerEdits(false);
        } catch (error) {
          console.error('Error checking server edits:', error);
          this.showStatus(`Error: ${error.message}`, 'error');
        } finally {
          checkNowBtn.disabled = false;
          checkNowBtn.textContent = '🔄 Check Server Edits Now';

          await this.loadServerEditSyncInfo();
        }
      });
    }

    if (viewHistoryBtn) {
      viewHistoryBtn.addEventListener('click', () => {
        this.showServerEditSyncHistory();
      });
    }

    this.loadServerEditSyncInfo();

    console.log('✓ Server edit sync UI setup complete with comparison feature');
  }

  /**
   * NEW: Compare server and local attendance records
   */
  async compareServerAndLocal() {
    const startDate = document.getElementById('compareStartDate').value;
    const endDate = document.getElementById('compareEndDate').value;
    const compareBtn = document.getElementById('compareServerLocalBtn');
    const resultsDiv = document.getElementById('comparisonResults');

    if (!startDate || !endDate) {
      this.showStatus('Please select both start and end dates', 'error');
      return;
    }

    if (startDate > endDate) {
      this.showStatus('Start date cannot be after end date', 'error');
      return;
    }

    compareBtn.disabled = true;
    compareBtn.textContent = '🔄 Comparing...';
    resultsDiv.style.display = 'none';

    try {
      this.showDownloadToast('🔍 Comparing server and local records...', 'info');

      const result = await this.electronAPI.invoke('compare-server-and-local', startDate, endDate);

      if (!result.success) {
        throw new Error(result.error || 'Comparison failed');
      }

      const comparison = result.comparison;

      this.showDownloadToast('✅ Comparison completed', 'success');

      // Display comparison results
      this.displayComparisonResults(comparison);
      resultsDiv.style.display = 'block';

    } catch (error) {
      console.error('Comparison error:', error);
      this.showDownloadToast(`❌ Comparison failed: ${error.message}`, 'error');
    } finally {
      compareBtn.disabled = false;
      compareBtn.textContent = '🔍 Compare';
    }
  }

  /**
   * NEW: Display comparison results in UI
   */
  displayComparisonResults(comparison) {
    const resultsDiv = document.getElementById('comparisonResults');

    const { serverOnly, localOnly, different, identical, duplicates } = comparison;

    let html = `
    <div class="comparison-summary" style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 20px;">
      <div class="stat-card" style="background: #dbeafe; padding: 10px; border-radius: 6px; text-align: center;">
        <div style="font-size: 24px; font-weight: bold; color: #1e40af;">${serverOnly.length}</div>
        <div style="font-size: 12px; color: #1e40af;">Server Only</div>
      </div>
      <div class="stat-card" style="background: #d1fae5; padding: 10px; border-radius: 6px; text-align: center;">
        <div style="font-size: 24px; font-weight: bold; color: #065f46;">${localOnly.length}</div>
        <div style="font-size: 12px; color: #065f46;">Local Only</div>
      </div>
      <div class="stat-card" style="background: #fef3c7; padding: 10px; border-radius: 6px; text-align: center;">
        <div style="font-size: 24px; font-weight: bold; color: #92400e;">${different.length}</div>
        <div style="font-size: 12px; color: #92400e;">Different</div>
      </div>
      <div class="stat-card" style="background: #e9d5ff; padding: 10px; border-radius: 6px; text-align: center;">
        <div style="font-size: 24px; font-weight: bold; color: #6b21a8;">${duplicates.length}</div>
        <div style="font-size: 12px; color: #6b21a8;">Duplicates</div>
      </div>
      <div class="stat-card" style="background: #f3f4f6; padding: 10px; border-radius: 6px; text-align: center;">
        <div style="font-size: 24px; font-weight: bold; color: #374151;">${identical.length}</div>
        <div style="font-size: 12px; color: #374151;">Identical</div>
      </div>
    </div>

    <div class="comparison-tabs" style="border-bottom: 2px solid #e5e7eb; margin-bottom: 15px;">
      <button class="comparison-tab active" data-tab="serverOnly" style="padding: 10px 20px; border: none; background: none; cursor: pointer; border-bottom: 3px solid #3b82f6; font-weight: bold;">
        Server Only (${serverOnly.length})
      </button>
      <button class="comparison-tab" data-tab="localOnly" style="padding: 10px 20px; border: none; background: none; cursor: pointer;">
        Local Only (${localOnly.length})
      </button>
      <button class="comparison-tab" data-tab="different" style="padding: 10px 20px; border: none; background: none; cursor: pointer;">
        Different (${different.length})
      </button>
      <button class="comparison-tab" data-tab="duplicates" style="padding: 10px 20px; border: none; background: none; cursor: pointer;">
        Duplicates (${duplicates.length})
      </button>
    </div>

    <div id="selectedActionsBar" style="display: none; padding: 15px; background: #eef2ff; border: 2px solid #6366f1; border-radius: 8px; margin-bottom: 15px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <strong id="selectedActionsCount">0</strong> action(s) selected
        </div>
        <div>
          <button id="clearSelectionsBtn" class="secondary-button" style="margin-right: 10px;">
            Clear Selection
          </button>
          <button id="applyActionsBtn" class="primary-button">
            ✅ Apply Selected Actions
          </button>
        </div>
      </div>
    </div>

    <div id="comparisonTabContent">
      <!-- Tab content will be inserted here -->
    </div>
  `;

    resultsDiv.innerHTML = html;

    // Store comparison data
    this.currentComparison = comparison;
    this.selectedActions = [];

    // Setup tab switching
    this.setupComparisonTabs();

    // Show initial tab content
    this.showComparisonTab('serverOnly');

    // Setup action buttons
    document.getElementById('clearSelectionsBtn')?.addEventListener('click', () => {
      this.selectedActions = [];
      this.updateSelectedActionsBar();
      this.showComparisonTab(this.currentComparisonTab || 'serverOnly');
    });

    document.getElementById('applyActionsBtn')?.addEventListener('click', () => {
      this.applySelectedActions();
    });
  }

  /**
   * NEW: Setup comparison tab switching
   */
  setupComparisonTabs() {
    const tabs = document.querySelectorAll('.comparison-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        tabs.forEach(t => {
          t.classList.remove('active');
          t.style.borderBottom = 'none';
          t.style.fontWeight = 'normal';
        });

        e.target.classList.add('active');
        e.target.style.borderBottom = '3px solid #3b82f6';
        e.target.style.fontWeight = 'bold';

        const tabName = e.target.dataset.tab;
        this.showComparisonTab(tabName);
      });
    });
  }

  /**
   * NEW: Show specific comparison tab content
   */
  showComparisonTab(tabName) {
    this.currentComparisonTab = tabName;
    const content = document.getElementById('comparisonTabContent');
    const data = this.currentComparison[tabName];

    if (!data || data.length === 0) {
      content.innerHTML = `
      <div style="text-align: center; padding: 40px; color: #6b7280;">
        <p style="font-size: 18px; margin: 0;">No ${tabName} records found</p>
      </div>
    `;
      return;
    }

    let html = '<div class="comparison-records" style="max-height: 400px; overflow-y: auto;">';

    if (tabName === 'serverOnly') {
      html += this.renderServerOnlyRecords(data);
    } else if (tabName === 'localOnly') {
      html += this.renderLocalOnlyRecords(data);
    } else if (tabName === 'different') {
      html += this.renderDifferentRecords(data);
    } else if (tabName === 'duplicates') {
      html += this.renderDuplicateRecords(data);
    }

    html += '</div>';
    content.innerHTML = html;

    // Setup record action buttons
    this.setupRecordActionButtons();
  }

  /**
   * NEW: Render server-only records
   */
  renderServerOnlyRecords(records) {
    return records.map(record => `
    <div class="record-card" style="background: #eff6ff; border: 1px solid #3b82f6; border-radius: 8px; padding: 15px; margin-bottom: 10px;">
      <div style="display: flex; justify-content: space-between; align-items: start;">
        <div style="flex: 1;">
          <div style="font-weight: bold; margin-bottom: 5px;">
            ID #${record.id} - ${record.first_name} ${record.last_name}
          </div>
          <div style="font-size: 12px; color: #374151; display: grid; grid-template-columns: 1fr 1fr; gap: 5px;">
            <div><strong>Date:</strong> ${record.date}</div>
            <div><strong>Type:</strong> ${record.clock_type}</div>
            <div><strong>Time:</strong> ${new Date(record.clock_time).toLocaleString()}</div>
            <div><strong>Hours:</strong> ${record.regular_hours || 0}h reg, ${record.overtime_hours || 0}h OT</div>
          </div>
          <div style="margin-top: 5px; font-size: 11px; color: #6b7280;">
            ☁️ This record exists on server but not locally
          </div>
        </div>
        <div>
          <button class="action-btn add-from-server" 
                  data-record-id="${record.id}"
                  data-action="add_from_server"
                  style="padding: 8px 16px; background: #3b82f6; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px;">
            ⬇️ Add to Local
          </button>
        </div>
      </div>
    </div>
  `).join('');
  }

  /**
   * NEW: Render local-only records
   */
  renderLocalOnlyRecords(records) {
    return records.map(record => `
    <div class="record-card" style="background: #f0fdf4; border: 1px solid #10b981; border-radius: 8px; padding: 15px; margin-bottom: 10px;">
      <div style="display: flex; justify-content: space-between; align-items: start;">
        <div style="flex: 1;">
          <div style="font-weight: bold; margin-bottom: 5px;">
            ID #${record.id} - ${record.first_name} ${record.last_name}
          </div>
          <div style="font-size: 12px; color: #374151; display: grid; grid-template-columns: 1fr 1fr; gap: 5px;">
            <div><strong>Date:</strong> ${record.date}</div>
            <div><strong>Type:</strong> ${record.clock_type}</div>
            <div><strong>Time:</strong> ${new Date(record.clock_time).toLocaleString()}</div>
            <div><strong>Hours:</strong> ${record.regular_hours || 0}h reg, ${record.overtime_hours || 0}h OT</div>
          </div>
          <div style="margin-top: 5px; font-size: 11px; color: #6b7280;">
            💾 This record exists locally but not on server
          </div>
        </div>
        <div style="display: flex; gap: 5px;">
          <button class="action-btn delete-local" 
                  data-record-id="${record.id}"
                  data-action="delete_local"
                  data-employee-uid="${record.employee_uid}"
                  data-date="${record.date}"
                  style="padding: 8px 16px; background: #ef4444; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px;">
            🗑️ Delete
          </button>
        </div>
      </div>
    </div>
  `).join('');
  }

  /**
   * NEW: Render different records (same ID, different data)
   */
  renderDifferentRecords(records) {
    return records.map(diff => `
    <div class="record-card" style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 15px; margin-bottom: 10px;">
      <div style="font-weight: bold; margin-bottom: 10px;">
        Record ID #${diff.id} - Differences Found
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 10px;">
        <div style="background: #dbeafe; padding: 10px; border-radius: 6px;">
          <div style="font-weight: bold; color: #1e40af; margin-bottom: 5px;">☁️ Server Version</div>
          <div style="font-size: 12px;">
            <div><strong>Type:</strong> ${diff.server.clock_type}</div>
            <div><strong>Time:</strong> ${new Date(diff.server.clock_time).toLocaleString()}</div>
            <div><strong>Hours:</strong> ${diff.server.regular_hours}h reg, ${diff.server.overtime_hours}h OT</div>
          </div>
        </div>
        <div style="background: #d1fae5; padding: 10px; border-radius: 6px;">
          <div style="font-weight: bold; color: #065f46; margin-bottom: 5px;">💾 Local Version</div>
          <div style="font-size: 12px;">
            <div><strong>Type:</strong> ${diff.local.clock_type}</div>
            <div><strong>Time:</strong> ${new Date(diff.local.clock_time).toLocaleString()}</div>
            <div><strong>Hours:</strong> ${diff.local.regular_hours}h reg, ${diff.local.overtime_hours}h OT</div>
          </div>
        </div>
      </div>
      <div style="background: #fee2e2; padding: 8px; border-radius: 6px; font-size: 11px; margin-bottom: 10px;">
        <strong>Differences:</strong> ${diff.differences.map(d => `${d.field}: "${d.server}" vs "${d.local}"`).join(', ')}
      </div>
      <div style="display: flex; gap: 10px; justify-content: flex-end;">
        <button class="action-btn update-from-server" 
                data-record-id="${diff.id}"
                data-action="update_from_server"
                style="padding: 8px 16px; background: #3b82f6; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px;">
          ⬇️ Use Server Version
        </button>
        <button class="action-btn keep-local" 
                data-record-id="${diff.id}"
                data-action="keep_local"
                data-employee-uid="${diff.local.employee_uid}"
                data-date="${diff.local.date}"
                style="padding: 8px 16px; background: #10b981; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px;">
          ✅ Keep Local Version
        </button>
      </div>
    </div>
  `).join('');
  }

  /**
   * NEW: Render duplicate records
   */
  renderDuplicateRecords(duplicates) {
    return duplicates.map((dup, idx) => `
    <div class="record-card" style="background: #fae8ff; border: 1px solid #a855f7; border-radius: 8px; padding: 15px; margin-bottom: 10px;">
      <div style="font-weight: bold; color: #7e22ce; margin-bottom: 10px;">
        🔄 Duplicate Set #${idx + 1} - ${dup.records.length} similar records
      </div>
      <div style="font-size: 12px; color: #6b7280; margin-bottom: 10px;">
        Same employee, date, clock type with similar times (within 5 minutes)
      </div>
      ${dup.records.map(record => `
        <div style="background: white; padding: 10px; border: 1px solid #d8b4fe; border-radius: 6px; margin-bottom: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: start;">
            <div style="flex: 1;">
              <div style="font-weight: bold;">
                ID #${record.id} 
                <span style="background: ${record._source === 'server' ? '#dbeafe' : '#d1fae5'}; padding: 2px 8px; border-radius: 4px; font-size: 11px;">
                  ${record._source === 'server' ? '☁️ Server' : '💾 Local'}
                </span>
              </div>
              <div style="font-size: 12px; margin-top: 5px;">
                ${record.first_name} ${record.last_name} | ${record.date} | ${record.clock_type}
                <br>Time: ${new Date(record.clock_time).toLocaleString()}
                <br>Hours: ${record.regular_hours}h reg, ${record.overtime_hours}h OT
              </div>
            </div>
            <button class="action-btn delete-local" 
                    data-record-id="${record.id}"
                    data-action="delete_local"
                    data-employee-uid="${record.employee_uid}"
                    data-date="${record.date}"
                    style="padding: 6px 12px; background: #ef4444; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px;">
              🗑️ Delete
            </button>
          </div>
        </div>
      `).join('')}
    </div>
  `).join('');
  }

  /**
   * NEW: Setup action button listeners
   */
  setupRecordActionButtons() {
    const actionButtons = document.querySelectorAll('.action-btn');

    actionButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const button = e.target;
        const recordId = parseInt(button.dataset.recordId);
        const actionType = button.dataset.action;
        const employeeUid = button.dataset.employeeUid;
        const date = button.dataset.date;

        // Find the full record data
        let recordData = null;
        const tabName = this.currentComparisonTab;
        const tabData = this.currentComparison[tabName];

        if (actionType === 'add_from_server') {
          recordData = tabData.find(r => r.id === recordId);
        } else if (actionType === 'update_from_server') {
          const diff = tabData.find(d => d.id === recordId);
          recordData = diff ? diff.server : null;
        }

        const action = {
          type: actionType,
          recordId: recordId,
          record: recordData,
          employeeUid: employeeUid,
          date: date
        };

        // Toggle selection
        const existingIndex = this.selectedActions.findIndex(a =>
          a.recordId === recordId && a.type === actionType
        );

        if (existingIndex >= 0) {
          this.selectedActions.splice(existingIndex, 1);
          button.style.opacity = '1';
          button.style.transform = 'scale(1)';
        } else {
          this.selectedActions.push(action);
          button.style.opacity = '0.6';
          button.style.transform = 'scale(0.95)';
        }

        this.updateSelectedActionsBar();
      });
    });
  }

  /**
   * NEW: Update selected actions bar
   */
  updateSelectedActionsBar() {
    const bar = document.getElementById('selectedActionsBar');
    const countElement = document.getElementById('selectedActionsCount');

    if (this.selectedActions.length > 0) {
      bar.style.display = 'block';
      countElement.textContent = this.selectedActions.length;
    } else {
      bar.style.display = 'none';
    }
  }

  /**
   * NEW: Apply selected actions
   */
  async applySelectedActions() {
    if (this.selectedActions.length === 0) {
      this.showStatus('No actions selected', 'warning');
      return;
    }

    const confirmMessage = `Apply ${this.selectedActions.length} action(s)?\n\nThis will:\n` +
      `- Modify your local database\n` +
      `- Validate affected records\n` +
      `- Rebuild daily summaries\n` +
      `- Upload summaries to server\n\n` +
      `This operation cannot be undone.`;

    if (!confirm(confirmMessage)) {
      return;
    }

    const applyBtn = document.getElementById('applyActionsBtn');
    applyBtn.disabled = true;
    applyBtn.textContent = '⏳ Applying...';

    try {
      this.showDownloadToast(`🔄 Applying ${this.selectedActions.length} actions...`, 'info');

      const result = await this.electronAPI.invoke('apply-comparison-actions', this.selectedActions);

      if (!result.success) {
        throw new Error(result.error || 'Failed to apply actions');
      }

      const { results } = result;

      this.showDownloadToast(
        `✅ Success!\n` +
        `Added: ${results.added}\n` +
        `Updated: ${results.updated}\n` +
        `Deleted: ${results.deleted}\n` +
        `Summaries: ${results.summariesRebuilt} rebuilt, ${results.summariesUploaded} uploaded`,
        'success'
      );

      // Clear selections and refresh comparison
      this.selectedActions = [];
      this.updateSelectedActionsBar();

      // Refresh comparison to show updated state
      await this.compareServerAndLocal();

      // Refresh attendance data
      await this.loadTodayAttendance();

    } catch (error) {
      console.error('Error applying actions:', error);
      this.showDownloadToast(`❌ Error: ${error.message}`, 'error');
    } finally {
      applyBtn.disabled = false;
      applyBtn.textContent = '✅ Apply Selected Actions';
    }
  }
}

// Optimized AttendanceApp for rapid barcode scanning
class OptimizedAttendanceApp extends AttendanceApp {
  constructor() {
    super();

    // Enhanced caching for rapid display
    this.employeeCache = new Map();
    // Don't redefine imageCache here - it's inherited from parent
    this.displayQueue = [];
    this.isProcessingQueue = false;

    // Pre-compiled display templates
    this.templates = {
      employeeDisplay: this.compileEmployeeTemplate(),
      clockedEmployee: this.compileCurrentlyLockedTemplate(),
      activityItem: this.compileActivityTemplate(),
    };

    // Batch processing controls
    this.batchTimeout = null;
    this.pendingUpdates = {
      attendance: false,
      currentlyClocked: false,
      statistics: false,
    };
  }

  // Pre-compile templates for faster rendering
  compileEmployeeTemplate() {
    return (data) => {
      const {
        employee,
        clockType,
        sessionType,
        clockTime,
        regularHours,
        overtimeHours,
        isOvertimeSession,
      } = data;
      const totalHours = (regularHours || 0) + (overtimeHours || 0);
      const fullName = `${employee.first_name} ${employee.middle_name || ""} ${employee.last_name
        }`.trim();

      return {
        name: fullName,
        department: employee.department || "No Department",
        idNumber: `ID: ${employee.id_number}`,
        clockType: this.formatClockType(clockType, sessionType),
        clockTypeClass: `clock-type ${clockType.replace("_", "-")} ${isOvertimeSession ? "overtime" : ""
          }`,
        clockTime: new Date(clockTime).toLocaleTimeString(),
        hoursHtml: isOvertimeSession
          ? `
          <div class="hours-breakdown overtime-session">
            <div class="regular-hours">Regular: ${regularHours || 0}h</div>
            <div class="overtime-hours">Overtime: ${overtimeHours || 0}h</div>
            <div class="total-hours">Total: ${totalHours.toFixed(2)}h</div>
            <div class="session-indicator">🌙 ${sessionType || "Overtime Session"
          }</div>
          </div>
        `
          : `
          <div class="hours-breakdown">
            <div class="regular-hours">Regular: ${regularHours || 0}h</div>
            <div class="overtime-hours">Overtime: ${overtimeHours.toFixed(
            2
          )}h</div>
            <div class="total-hours">Total: ${totalHours.toFixed(2)}h</div>
          </div>
        `,
        uid: employee.uid,
      };
    };
  }

  // MISSING METHOD: Pre-compile template for currently clocked employees
  compileCurrentlyLockedTemplate() {
    return (data) => {
      const {
        employee,
        clockInTime,
        currentHours,
        sessionType,
        isOvertimeSession,
      } = data;
      const fullName = `${employee.first_name} ${employee.middle_name || ""} ${employee.last_name
        }`.trim();
      const clockInDate = new Date(clockInTime);
      const duration = currentHours
        ? `${currentHours.toFixed(1)}h`
        : "Calculating...";

      return {
        name: fullName,
        department: employee.department || "No Department",
        idNumber: `ID: ${employee.id_number}`,
        clockInTime: clockInDate.toLocaleTimeString(),
        duration: duration,
        statusClass: isOvertimeSession ? "overtime-active" : "regular-active",
        sessionIndicator: isOvertimeSession ? "🌙 Overtime" : "☀️ Regular",
        uid: employee.uid,
      };
    };
  }

  // MISSING METHOD: Pre-compile template for activity items
  compileActivityTemplate() {
    return (data) => {
      const { employee, clockType, clockTime, sessionType, isOvertimeSession } =
        data;
      const fullName = `${employee.first_name} ${employee.middle_name || ""} ${employee.last_name
        }`.trim();
      const timeFormatted = new Date(clockTime).toLocaleTimeString();

      return {
        name: fullName,
        department: employee.department || "No Department",
        clockType: this.formatClockType(clockType, sessionType),
        clockTime: timeFormatted,
        activityClass: `activity-${clockType.replace("_", "-")} ${isOvertimeSession ? "overtime" : ""
          }`,
        sessionIndicator: isOvertimeSession ? "🌙" : "☀️",
        uid: employee.uid,
      };
    };
  }

  // PERFORMANCE: Enhanced handleScan with fast cache lookup
  async handleScan() {
    if (this.barcodeTimeout) {
      clearTimeout(this.barcodeTimeout);
    }

    const input = document.getElementById("barcodeInput").value.trim();
    const inputType = document.querySelector(
      'input[name="inputType"]:checked'
    ).value;

    if (!input) {
      this.showStatus("Please enter a barcode or ID number", "error");
      this.focusInput();
      return;
    }

    if (this.isDuplicateScan(input)) {
      this.showStatus(
        "Duplicate scan detected - please wait before scanning again",
        "warning"
      );
      this.focusInput();
      return;
    }

    this.updateLastScanData(input);
    this.showLoadingScreen();

    const barcodeInput = document.getElementById("barcodeInput");
    const submitButton = document.getElementById("manualSubmit");
    const originalText = submitButton.textContent;

    barcodeInput.disabled = true;
    submitButton.textContent = "Processing...";
    submitButton.disabled = true;

    try {
      // PERFORMANCE: Check renderer cache first for profile preview
      let profilePreview = this.profileCache.get(input);
      let cacheHit = false;

      if (profilePreview) {
        console.log(`Cache hit for profile preview: ${input}`);
        cacheHit = true;
        // Show preview immediately from cache
        this.showEmployeePreview(profilePreview);
      }

      // Always perform the actual clock operation
      const result = await this.electronAPI.clockAttendance({
        input: input,
        inputType: inputType,
      });

      if (result.success) {
        await new Promise((resolve) =>
          setTimeout(resolve, cacheHit ? 100 : 200)
        );

        this.hideLoadingScreen();
        this.showEmployeeDisplay(result.data);

        // PERFORMANCE: Cache the employee data
        if (result.data.employee) {
          this.cacheEmployeeData(input, result.data.employee);
        }

        this.clearInput();
        this.showStatus("Attendance recorded successfully", "success");
        this.deferredOperations(result.data);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        this.hideLoadingScreen();
        this.showStatus(result.error || "Employee not found", "error");
        this.focusInput();
      }
    } catch (error) {
      console.error("Clock error:", error);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      this.hideLoadingScreen();
      this.showStatus("System error occurred", "error");
      this.focusInput();
    } finally {
      barcodeInput.disabled = false;
      submitButton.textContent = originalText;
      submitButton.disabled = false;
    }
  }

  // PERFORMANCE: Cache employee data in renderer
  cacheEmployeeData(barcode, employeeData) {
    const cacheKey = barcode;
    const cacheData = {
      ...employeeData,
      cached_at: Date.now(),
      cache_source: "renderer",
    };

    this.profileCache.set(cacheKey, cacheData);
    this.preloadedProfiles.add(barcode);

    // Limit cache size to prevent memory issues
    if (this.profileCache.size > 100) {
      const firstKey = this.profileCache.keys().next().value;
      this.profileCache.delete(firstKey);
    }

    console.log(`Cached employee data for ${barcode}`);
  }

  // PERFORMANCE: Show employee preview from cache
  showEmployeePreview(employeeData) {
    // Show a quick preview while the actual attendance is being processed
    console.log(`Showing cached preview for ${employeeData.uid}`);
    // You can implement a brief preview UI here if desired
  }

  // PERFORMANCE: Start cache monitoring
  startCacheMonitoring() {
    // Monitor cache performance every 2 minutes
    this.cacheStatsInterval = setInterval(async () => {
      try {
        const cacheStats = await this.electronAPI.getCacheStats();
        if (cacheStats.success) {
          this.lastCacheStats = cacheStats.data;

          // Log cache performance in development
          if (console && typeof console.log === "function") {
            const stats = cacheStats.data;
            console.log("Cache Performance:", {
              profileCache: `${stats.profileCache.size}/${stats.profileCache.max}`,
              imageCache: `${stats.imageCache.size}/${stats.imageCache.max}`,
              rendererProfile: this.profileCache.size,
              rendererImage: this.imageCache.size,
              preloaded: this.preloadedProfiles.size,
            });
          }
        }
      } catch (error) {
        console.warn("Cache monitoring error:", error);
      }
    }, 120000); // 2 minutes
  }

  // Ultra-fast employee display using pre-compiled templates
  showEmployeeDisplayOptimized(data) {
    const display = document.getElementById("employeeDisplay");
    const compiled = this.templates.employeeDisplay(data);

    // Use faster DOM updates
    this.updateDisplayElements(compiled);

    // Handle image loading non-blocking
    this.loadImageAsync(compiled.uid, compiled.name);

    display.style.display = "block";

    // Shorter timeout for rapid scanning
    if (this.employeeDisplayTimeout) {
      clearTimeout(this.employeeDisplayTimeout);
    }

    this.employeeDisplayTimeout = setTimeout(() => {
      display.style.display = "none";
      this.focusInput();
    }, 3000); // Reduced to 3 seconds for rapid scanning
  }

  // Batch DOM updates for better performance
  updateDisplayElements(compiled) {
    // Use DocumentFragment for batch updates
    const elements = {
      employeeName: document.getElementById("employeeName"),
      employeeDepartment: document.getElementById("employeeDepartment"),
      employeeId: document.getElementById("employeeId"),
      clockType: document.getElementById("clockType"),
      clockTime: document.getElementById("clockTime"),
      hoursInfo: document.getElementById("hoursInfo"),
    };

    // Batch all updates
    requestAnimationFrame(() => {
      elements.employeeName.textContent = compiled.name;
      elements.employeeDepartment.textContent = compiled.department;
      elements.employeeId.textContent = compiled.idNumber;
      elements.clockType.textContent = compiled.clockType;
      elements.clockType.className = compiled.clockTypeClass;
      elements.clockTime.textContent = compiled.clockTime;
      elements.hoursInfo.innerHTML = compiled.hoursHtml;
    });
  }

  // Non-blocking image loading
  loadImageAsync(uid, altText) {
    const photo = document.getElementById("employeePhoto");

    // Check cache first
    if (this.imageCache.has(uid)) {
      photo.src = this.imageCache.get(uid);
      return;
    }

    // Load in background without blocking
    setTimeout(() => {
      this.setupImageWithFallback(photo, uid, altText);
    }, 10);
  }

  // Process cached scan for ultra-fast response
  async processCachedScan(input, inputType, cachedData) {
    // Simulate quick clock operation with cached employee
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          success: true,
          data: {
            ...cachedData,
            clockTime: new Date().toISOString(),
            // Update hours based on new clock
            regularHours: cachedData.regularHours + 0.1,
            overtimeHours: cachedData.overtimeHours,
          },
        });
      }, 50); // Ultra-fast 50ms response
    });
  }

  // Process full scan when no cache available
  async processFullScan(input, inputType) {
    return await this.electronAPI.clockAttendance({
      input: input,
      inputType: inputType,
    });
  }

  // Cache employee data for rapid subsequent scans
  cacheEmployeeData(input, data) {
    const cacheEntry = {
      ...data,
      cachedAt: Date.now(),
      hitCount: (this.employeeCache.get(input)?.hitCount || 0) + 1,
    };

    this.employeeCache.set(input, cacheEntry);

    // Limit cache size
    if (this.employeeCache.size > 100) {
      const oldestKey = this.employeeCache.keys().next().value;
      this.employeeCache.delete(oldestKey);
    }
  }

  // Check if cached data is still valid
  shouldUseCachedData(cachedData) {
    const cacheAge = Date.now() - cachedData.cachedAt;
    const maxAge = 30000; // 30 seconds
    return cacheAge < maxAge;
  }

  // Ultra-fast status display
  showRapidStatus(symbol, type) {
    let statusEl = document.getElementById("rapidStatusSymbol");

    if (!statusEl) {
      statusEl = document.createElement("div");
      statusEl.id = "rapidStatusSymbol";
      statusEl.className = "rapid-status-symbol";
      statusEl.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        font-size: 48px;
        font-weight: bold;
        z-index: 10001;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.1s ease;
      `;
      document.body.appendChild(statusEl);
    }

    statusEl.textContent = symbol;
    statusEl.style.color =
      {
        success: "#22c55e",
        error: "#ef4444",
        warning: "#f59e0b",
      }[type] || "#3b82f6";

    statusEl.style.opacity = "1";

    setTimeout(() => {
      statusEl.style.opacity = "0";
    }, 300);
  }

  // Set processing state with minimal UI changes
  setProcessingState(isProcessing) {
    const input = document.getElementById("barcodeInput");
    const button = document.getElementById("manualSubmit");

    if (isProcessing) {
      input.style.borderColor = "#007cff";
      button.textContent = "⚡";
    } else {
      input.style.borderColor = "";
      button.textContent = "Submit";
    }

    input.disabled = isProcessing;
    button.disabled = isProcessing;
  }

  // Queue background updates to avoid blocking UI
  queueBackgroundUpdates(data) {
    this.pendingUpdates.attendance = true;
    this.pendingUpdates.currentlyClocked = true;
    this.pendingUpdates.statistics = true;

    // Debounce updates
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
    }

    this.batchTimeout = setTimeout(() => {
      this.processBatchUpdates();
    }, 1000); // Batch updates after 1 second of no new scans
  }

  // Process batched background updates
  async processBatchUpdates() {
    if (this.pendingUpdates.attendance) {
      this.loadTodayAttendance();
      this.pendingUpdates.attendance = false;
    }

    if (
      this.pendingUpdates.currentlyClocked ||
      this.pendingUpdates.statistics
    ) {
      this.markSummaryDataChanged();
      this.pendingUpdates.currentlyClocked = false;
      this.pendingUpdates.statistics = false;
    }

    // Queue sync after all UI updates
    setTimeout(() => {
      this.performAttendanceSync(true);
    }, 2000);
  }

  // Optimized input focus with selection
  focusInput() {
    const input = document.getElementById("barcodeInput");
    // Use RAF for smoother focus
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  // Enhanced clear input
  clearInput() {
    const input = document.getElementById("barcodeInput");
    input.value = "";
    // Immediate focus for next scan
    setTimeout(() => this.focusInput(), 10);
  }

  // Cleanup enhanced cache on destroy
  destroy() {
    super.destroy();

    // Clear caches
    this.employeeCache.clear();
    this.imageCache.clear();

    // Clear batch timeout
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
    }

    console.log("OptimizedAttendanceApp destroyed with cache cleanup");
  }
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
  console.log('DOM loaded, initializing attendance system...');

  // Store reference globally for cleanup if needed
  window.attendanceApp = new AttendanceApp();

  // Log face-api.js status for debugging
  setTimeout(() => {
    if (typeof faceapi !== 'undefined') {
      console.log('✓ face-api.js is available');
    } else {
      console.warn('✗ face-api.js is NOT available - check if script is loaded');
    }
  }, 1000);
});
// Clean up on page unload
window.addEventListener('beforeunload', () => {
  if (window.attendanceApp && typeof window.attendanceApp.destroy === 'function') {
    window.attendanceApp.destroy();
  }

  // Clean up face recognition
  if (window.attendanceApp?.faceRecognitionManager &&
    typeof window.attendanceApp.faceRecognitionManager.destroy === 'function') {
    window.attendanceApp.faceRecognitionManager.destroy();
  }
});
