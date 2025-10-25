// services/serverEditSync.js - Complete Enhanced with Comparison Feature
const { getDatabase, updateDailyAttendanceSummary } = require('../database/setup');
const { broadcastUpdate } = require('./websocket');
const { AttendanceValidationService } = require('./validateTime');

class ServerEditSyncService {
  constructor() {
    this.db = null;
    this.lastSyncTimestamp = null;
    this.isInitialized = false;
    this.syncHistory = [];
    this.maxHistorySize = 50;
    this.comparisonCache = null; // Cache comparison results
  }

  async initialize() {
    try {
      this.db = getDatabase();

      if (!this.db) {
        throw new Error('Database not available');
      }

      this.lastSyncTimestamp = null;
      this.isInitialized = true;

      console.log('✓ Server Edit Sync Service initialized (Manual mode with Comparison)');

      return { success: true };
    } catch (error) {
      console.error('Failed to initialize ServerEditSyncService:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * NEW: Compare server and local attendance records for a date range
   * Returns detailed comparison with actions needed
   */
  async compareServerAndLocal(startDate, endDate) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      console.log('==========================================');
      console.log('COMPARISON: Analyzing server vs local data...');
      console.log(`Date Range: ${startDate} to ${endDate}`);
      console.log('==========================================');

      // Get server URL
      const settings = this.db.prepare("SELECT value FROM settings WHERE key = 'server_url' LIMIT 1").get();
      if (!settings || !settings.value) {
        throw new Error('No server URL configured');
      }

      const serverUrl = settings.value.replace(/\/api\/employees.*$/, '');
      
      // Fetch server attendance for date range
      const serverRecords = await this.fetchServerAttendanceByDateRange(serverUrl, startDate, endDate);
      
      // Fetch local attendance for date range
      const localRecords = this.fetchLocalAttendanceByDateRange(startDate, endDate);

      // Perform comparison
      const comparison = this.analyzeRecords(serverRecords, localRecords);

      // Cache the comparison for later use
      this.comparisonCache = {
        ...comparison,
        startDate,
        endDate,
        timestamp: new Date().toISOString()
      };

      console.log('\n📊 COMPARISON RESULTS:');
      console.log(`  Server Only: ${comparison.serverOnly.length} records`);
      console.log(`  Local Only: ${comparison.localOnly.length} records`);
      console.log(`  Different: ${comparison.different.length} records`);
      console.log(`  Identical: ${comparison.identical.length} records`);
      console.log(`  Duplicates: ${comparison.duplicates.length} sets`);
      console.log('==========================================');

      return {
        success: true,
        comparison: this.comparisonCache
      };

    } catch (error) {
      console.error('❌ Error comparing records:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Fetch server attendance records for date range
   */
  async fetchServerAttendanceByDateRange(serverUrl, startDate, endDate) {
    const url = `${serverUrl}/api/attendanceEdit/range?start_date=${startDate}&end_date=${endDate}`;
    
    console.log(`📡 Fetching from server: ${url}`);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`Server responded with ${response.status}`);
    }

    const result = await response.json();
    
    if (!result.success) {
      throw new Error(result.error || 'Server returned error');
    }

    console.log(`✓ Fetched ${result.data?.length || 0} records from server`);
    return result.data || [];
  }

  /**
   * Fetch local attendance records for date range
   */
  fetchLocalAttendanceByDateRange(startDate, endDate) {
    const stmt = this.db.prepare(`
      SELECT 
        a.*,
        e.first_name,
        e.middle_name,
        e.last_name,
        e.department
      FROM attendance a
      LEFT JOIN employees e ON a.employee_uid = e.uid
      WHERE a.date BETWEEN ? AND ?
      ORDER BY a.date, a.employee_uid, a.clock_time
    `);

    const records = stmt.all(startDate, endDate);
    console.log(`✓ Fetched ${records.length} records from local database`);
    return records;
  }

  /**
 * ENHANCED: Analyze records for TWO-WAY sync
 * Identifies what needs to be synced in BOTH directions
 */
analyzeRecords(serverRecords, localRecords) {
  const serverMap = new Map();
  const localMap = new Map();
  
  // Index server records by ID
  serverRecords.forEach(record => {
    serverMap.set(record.id, record);
  });

  // Index local records by ID
  localRecords.forEach(record => {
    localMap.set(record.id, record);
  });

  const comparison = {
    serverOnly: [],           // Records on SERVER but not LOCAL → Download these
    localOnly: [],            // Records on LOCAL but not SERVER → Upload these
    different: [],            // Records with same ID but different data → Resolve conflicts
    identical: [],            // Records that match perfectly → No action needed
    deletedFromServer: [],    // NEW: Records that were deleted from server
    duplicates: [],           // Potential duplicate records (same employee, date, time)
    
    // NEW: Action recommendations
    recommendations: {
      downloadFromServer: 0,  // serverOnly count
      uploadToServer: 0,      // localOnly count
      deleteLocally: 0,       // deletedFromServer count
      resolveConflicts: 0,    // different count
      reviewDuplicates: 0     // duplicates count
    }
  };

  // Track all record IDs we've seen
  const allRecordIds = new Set([...serverMap.keys(), ...localMap.keys()]);

  // Find server-only and different records
  serverRecords.forEach(serverRecord => {
    const localRecord = localMap.get(serverRecord.id);
    
    if (!localRecord) {
      comparison.serverOnly.push({
        ...serverRecord,
        _source: 'server',
        _action: 'download' // Recommended action
      });
    } else {
      const isDifferent = this.compareRecordFields(serverRecord, localRecord);
      if (isDifferent) {
        comparison.different.push({
          id: serverRecord.id,
          server: serverRecord,
          local: localRecord,
          differences: this.getFieldDifferences(serverRecord, localRecord),
          _action: 'resolve' // Needs manual resolution
        });
      } else {
        comparison.identical.push({
          id: serverRecord.id,
          data: serverRecord,
          _action: 'none' // Already in sync
        });
      }
    }
  });

  // Find local-only records
  localRecords.forEach(localRecord => {
    if (!serverMap.has(localRecord.id)) {
      comparison.localOnly.push({
        ...localRecord,
        _source: 'local',
        _action: 'upload' // Recommended action
      });
    }
  });

  // NEW: Detect records deleted from server
  // These are records that exist locally but were intentionally removed from server
  // We detect this by checking if local records have is_synced = 1 but don't exist on server
  localRecords.forEach(localRecord => {
    if (localRecord.is_synced === 1 && !serverMap.has(localRecord.id)) {
      // This record was previously synced but is now missing from server
      // It was likely deleted on the server
      comparison.deletedFromServer.push({
        ...localRecord,
        _source: 'local',
        _action: 'delete_local', // Should be deleted locally
        _reason: 'Server deleted this record'
      });
    }
  });

  // Remove deletedFromServer records from localOnly
  // (they shouldn't be uploaded, they should be deleted)
  const deletedIds = new Set(comparison.deletedFromServer.map(r => r.id));
  comparison.localOnly = comparison.localOnly.filter(r => !deletedIds.has(r.id));

  // Detect duplicates (same employee, date, clock_type, similar time)
  comparison.duplicates = this.findDuplicates([...serverRecords, ...localRecords]);

  // Calculate recommendations
  comparison.recommendations = {
    downloadFromServer: comparison.serverOnly.length,
    uploadToServer: comparison.localOnly.length,
    deleteLocally: comparison.deletedFromServer.length,
    resolveConflicts: comparison.different.length,
    reviewDuplicates: comparison.duplicates.length
  };

  return comparison;
}

/**
 * NEW: Display enhanced comparison results with two-way sync info
 */
displayComparisonResults(comparison) {
  const resultsDiv = document.getElementById('comparisonResults');
  
  const { serverOnly, localOnly, different, identical, deletedFromServer, duplicates, recommendations } = comparison;

  let html = `
    <div class="comparison-summary" style="display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 20px;">
      <div class="stat-card" style="background: #dbeafe; padding: 10px; border-radius: 6px; text-align: center;">
        <div style="font-size: 24px; font-weight: bold; color: #1e40af;">${serverOnly.length}</div>
        <div style="font-size: 12px; color: #1e40af;">⬇️ Download</div>
        <div style="font-size: 10px; color: #64748b;">Server → Local</div>
      </div>
      <div class="stat-card" style="background: #d1fae5; padding: 10px; border-radius: 6px; text-align: center;">
        <div style="font-size: 24px; font-weight: bold; color: #065f46;">${localOnly.length}</div>
        <div style="font-size: 12px; color: #065f46;">⬆️ Upload</div>
        <div style="font-size: 10px; color: #64748b;">Local → Server</div>
      </div>
      <div class="stat-card" style="background: #fee2e2; padding: 10px; border-radius: 6px; text-align: center;">
        <div style="font-size: 24px; font-weight: bold; color: #991b1b;">${deletedFromServer.length}</div>
        <div style="font-size: 12px; color: #991b1b;">🗑️ Delete</div>
        <div style="font-size: 10px; color: #64748b;">Remove locally</div>
      </div>
      <div class="stat-card" style="background: #fef3c7; padding: 10px; border-radius: 6px; text-align: center;">
        <div style="font-size: 24px; font-weight: bold; color: #92400e;">${different.length}</div>
        <div style="font-size: 12px; color: #92400e;">⚠️ Conflicts</div>
        <div style="font-size: 10px; color: #64748b;">Need resolution</div>
      </div>
      <div class="stat-card" style="background: #e9d5ff; padding: 10px; border-radius: 6px; text-align: center;">
        <div style="font-size: 24px; font-weight: bold; color: #6b21a8;">${duplicates.length}</div>
        <div style="font-size: 12px; color: #6b21a8;">🔄 Duplicates</div>
        <div style="font-size: 10px; color: #64748b;">Review needed</div>
      </div>
      <div class="stat-card" style="background: #f3f4f6; padding: 10px; border-radius: 6px; text-align: center;">
        <div style="font-size: 24px; font-weight: bold; color: #374151;">${identical.length}</div>
        <div style="font-size: 12px; color: #374151;">✅ In Sync</div>
        <div style="font-size: 10px; color: #64748b;">No action</div>
      </div>
    </div>

    <!-- Action Summary -->
    <div class="action-summary" style="background: #f0f9ff; border: 2px solid #3b82f6; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
      <h4 style="margin: 0 0 10px 0; color: #1e40af;">📋 Recommended Actions</h4>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 14px;">
        ${recommendations.downloadFromServer > 0 ? `
          <div>⬇️ Download <strong>${recommendations.downloadFromServer}</strong> records from server</div>
        ` : ''}
        ${recommendations.uploadToServer > 0 ? `
          <div>⬆️ Upload <strong>${recommendations.uploadToServer}</strong> records to server</div>
        ` : ''}
        ${recommendations.deleteLocally > 0 ? `
          <div>🗑️ Delete <strong>${recommendations.deleteLocally}</strong> records locally (deleted on server)</div>
        ` : ''}
        ${recommendations.resolveConflicts > 0 ? `
          <div>⚠️ Resolve <strong>${recommendations.resolveConflicts}</strong> conflicts</div>
        ` : ''}
        ${recommendations.reviewDuplicates > 0 ? `
          <div>🔄 Review <strong>${recommendations.reviewDuplicates}</strong> duplicate sets</div>
        ` : ''}
      </div>
      ${recommendations.downloadFromServer === 0 && recommendations.uploadToServer === 0 && 
        recommendations.deleteLocally === 0 && recommendations.resolveConflicts === 0 ? `
        <div style="text-align: center; padding: 20px; color: #059669;">
          <strong>✅ Everything is in sync!</strong>
          <p style="margin: 5px 0 0 0; font-size: 13px;">Server and local databases are synchronized.</p>
        </div>
      ` : ''}
    </div>

    <div class="comparison-tabs" style="border-bottom: 2px solid #e5e7eb; margin-bottom: 15px;">
      <button class="comparison-tab active" data-tab="serverOnly" style="padding: 10px 20px; border: none; background: none; cursor: pointer; border-bottom: 3px solid #3b82f6; font-weight: bold;">
        ⬇️ Download (${serverOnly.length})
      </button>
      <button class="comparison-tab" data-tab="localOnly" style="padding: 10px 20px; border: none; background: none; cursor: pointer;">
        ⬆️ Upload (${localOnly.length})
      </button>
      <button class="comparison-tab" data-tab="deletedFromServer" style="padding: 10px 20px; border: none; background: none; cursor: pointer;">
        🗑️ Delete (${deletedFromServer.length})
      </button>
      <button class="comparison-tab" data-tab="different" style="padding: 10px 20px; border: none; background: none; cursor: pointer;">
        ⚠️ Conflicts (${different.length})
      </button>
      <button class="comparison-tab" data-tab="duplicates" style="padding: 10px 20px; border: none; background: none; cursor: pointer;">
        🔄 Duplicates (${duplicates.length})
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
 * ENHANCED: Show comparison tab with new deletedFromServer tab
 */
showComparisonTab(tabName) {
  this.currentComparisonTab = tabName;
  const content = document.getElementById('comparisonTabContent');
  const data = this.currentComparison[tabName];

  if (!data || data.length === 0) {
    const emptyMessages = {
      serverOnly: 'No records to download from server',
      localOnly: 'No records to upload to server',
      deletedFromServer: 'No records were deleted from server',
      different: 'No conflicting records found',
      duplicates: 'No duplicate records found'
    };

    content.innerHTML = `
      <div style="text-align: center; padding: 40px; color: #6b7280;">
        <p style="font-size: 18px; margin: 0;">${emptyMessages[tabName]}</p>
      </div>
    `;
    return;
  }

  let html = '<div class="comparison-records" style="max-height: 400px; overflow-y: auto;">';

  if (tabName === 'serverOnly') {
    html += this.renderServerOnlyRecords(data);
  } else if (tabName === 'localOnly') {
    html += this.renderLocalOnlyRecordsForUpload(data); // NEW: Upload version
  } else if (tabName === 'deletedFromServer') {
    html += this.renderDeletedFromServerRecords(data); // NEW
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
 * NEW: Render local-only records with UPLOAD action
 */
renderLocalOnlyRecordsForUpload(records) {
  return records.map(record => `
    <div class="record-card" style="background: #d1fae5; border: 1px solid #10b981; border-radius: 8px; padding: 15px; margin-bottom: 10px;">
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
            💾 This record exists locally but not on server → Should be uploaded
          </div>
        </div>
        <div style="display: flex; gap: 5px;">
          <button class="action-btn upload-to-server" 
                  data-record-id="${record.id}"
                  data-action="upload_to_server"
                  style="padding: 8px 16px; background: #10b981; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px;">
            ⬆️ Upload to Server
          </button>
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
 * NEW: Render deleted from server records
 */
renderDeletedFromServerRecords(records) {
  if (records.length === 0) {
    return '<div style="text-align: center; padding: 40px; color: #6b7280;"><p>No records were deleted from server</p></div>';
  }

  return records.map(record => `
    <div class="record-card" style="background: #fee2e2; border: 2px solid #dc2626; border-radius: 8px; padding: 15px; margin-bottom: 10px;">
      <div style="display: flex; justify-content: space-between; align-items: start;">
        <div style="flex: 1;">
          <div style="font-weight: bold; margin-bottom: 5px; color: #991b1b;">
            🗑️ ID #${record.id} - ${record.first_name} ${record.last_name}
          </div>
          <div style="font-size: 12px; color: #374151; display: grid; grid-template-columns: 1fr 1fr; gap: 5px;">
            <div><strong>Date:</strong> ${record.date}</div>
            <div><strong>Type:</strong> ${record.clock_type}</div>
            <div><strong>Time:</strong> ${new Date(record.clock_time).toLocaleString()}</div>
            <div><strong>Hours:</strong> ${record.regular_hours || 0}h reg, ${record.overtime_hours || 0}h OT</div>
          </div>
          <div style="margin-top: 8px; padding: 8px; background: #fef2f2; border-left: 3px solid #dc2626; font-size: 11px;">
            <strong>⚠️ Server Deletion Detected:</strong><br>
            This record was previously synced but no longer exists on the server.<br>
            It was likely deleted on the server and should be removed locally.
          </div>
        </div>
        <div>
          <button class="action-btn delete-local" 
                  data-record-id="${record.id}"
                  data-action="delete_local"
                  data-employee-uid="${record.employee_uid}"
                  data-date="${record.date}"
                  style="padding: 8px 16px; background: #dc2626; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: bold;">
            🗑️ Delete Locally
          </button>
        </div>
      </div>
    </div>
  `).join('');
}

  /**
   * Compare two records field by field
   */
  compareRecordFields(record1, record2) {
    const fieldsToCompare = [
      'employee_uid', 'clock_type', 'clock_time', 'date',
      'regular_hours', 'overtime_hours', 'is_late'
    ];

    return fieldsToCompare.some(field => {
      const val1 = this.normalizeValue(record1[field]);
      const val2 = this.normalizeValue(record2[field]);
      return val1 !== val2;
    });
  }

  /**
   * Get specific field differences
   */
  getFieldDifferences(serverRecord, localRecord) {
    const fieldsToCompare = [
      'employee_uid', 'clock_type', 'clock_time', 'date',
      'regular_hours', 'overtime_hours', 'is_late'
    ];

    const differences = [];

    fieldsToCompare.forEach(field => {
      const serverVal = this.normalizeValue(serverRecord[field]);
      const localVal = this.normalizeValue(localRecord[field]);
      
      if (serverVal !== localVal) {
        differences.push({
          field,
          server: serverVal,
          local: localVal
        });
      }
    });

    return differences;
  }

  /**
   * Normalize values for comparison
   */
  normalizeValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return value.toString();
    if (typeof value === 'string') return value.trim();
    return String(value);
  }

  /**
   * Find potential duplicate records
   */
  findDuplicates(allRecords) {
    const groups = new Map();
    
    allRecords.forEach(record => {
      const key = `${record.employee_uid}|${record.date}|${record.clock_type}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(record);
    });

    const duplicates = [];
    groups.forEach((records, key) => {
      if (records.length > 1) {
        // Check if times are similar (within 5 minutes)
        const times = records.map(r => new Date(r.clock_time).getTime());
        const timeDiffs = [];
        
        for (let i = 0; i < times.length - 1; i++) {
          for (let j = i + 1; j < times.length; j++) {
            const diff = Math.abs(times[i] - times[j]) / 1000 / 60; // minutes
            if (diff <= 5) {
              timeDiffs.push({ i, j, diff });
            }
          }
        }

        if (timeDiffs.length > 0) {
          duplicates.push({
            key,
            records,
            similarTimes: timeDiffs
          });
        }
      }
    });

    return duplicates;
  }

  /**
   * NEW: Apply selected comparison actions
   */
  async applyComparisonActions(actions) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    console.log('\n==========================================');
    console.log('APPLYING COMPARISON ACTIONS...');
    console.log('==========================================');

    const results = {
      added: 0,
      updated: 0,
      deleted: 0,
      errors: [],
      affectedDates: new Set()
    };

    try {
      const transaction = this.db.transaction(() => {
        // Process each action
        actions.forEach((action, index) => {
          try {
            switch (action.type) {
              case 'add_from_server':
                this.addRecordLocally(action.record);
                results.added++;
                results.affectedDates.add(`${action.record.employee_uid}|${action.record.date}`);
                console.log(`✓ Added record #${action.record.id} from server`);
                break;

              case 'update_from_server':
                this.updateRecordLocally(action.record);
                results.updated++;
                results.affectedDates.add(`${action.record.employee_uid}|${action.record.date}`);
                console.log(`✓ Updated record #${action.record.id} from server`);
                break;

              case 'delete_local':
                this.deleteRecordLocally(action.recordId);
                results.deleted++;
                if (action.employeeUid && action.date) {
                  results.affectedDates.add(`${action.employeeUid}|${action.date}`);
                }
                console.log(`✓ Deleted local record #${action.recordId}`);
                break;

              case 'keep_local':
                console.log(`✓ Kept local record #${action.recordId}`);
                break;

              default:
                console.warn(`⚠️ Unknown action type: ${action.type}`);
            }
          } catch (error) {
            results.errors.push({
              index,
              action: action.type,
              recordId: action.recordId || action.record?.id,
              error: error.message
            });
            console.error(`❌ Error applying action ${index}:`, error.message);
          }
        });
      });

      transaction();

      // Rebuild summaries for affected dates
      if (results.affectedDates.size > 0) {
        console.log(`\n🔄 Rebuilding ${results.affectedDates.size} daily summaries...`);
        const rebuildResults = await this.rebuildAffectedSummaries(results.affectedDates);
        results.summariesRebuilt = rebuildResults.rebuilt;
        results.summariesUploaded = rebuildResults.uploaded;
      }

      console.log('\n✅ ACTIONS APPLIED SUCCESSFULLY');
      console.log(`  Added: ${results.added}`);
      console.log(`  Updated: ${results.updated}`);
      console.log(`  Deleted: ${results.deleted}`);
      console.log(`  Summaries Rebuilt: ${results.summariesRebuilt || 0}`);
      console.log(`  Summaries Uploaded: ${results.summariesUploaded || 0}`);
      console.log('==========================================');

      // Broadcast update
      broadcastUpdate('comparison_actions_applied', {
        ...results,
        affectedDates: Array.from(results.affectedDates),
        timestamp: new Date().toISOString()
      });

      return {
        success: true,
        results
      };

    } catch (error) {
      console.error('❌ Error applying comparison actions:', error);
      return {
        success: false,
        error: error.message,
        results
      };
    }
  }

 /**
 * Add record to local database
 * FIXED: Handle ID conflicts and match local database schema
 */
addRecordLocally(record) {
  try {
    // First, check if a record with this ID already exists
    const existingRecord = this.db.prepare('SELECT id FROM attendance WHERE id = ?').get(record.id);
    
    if (existingRecord) {
      console.log(`Record ID ${record.id} already exists locally - updating instead of inserting`);
      
      // Update the existing record instead
      const updateStmt = this.db.prepare(`
        UPDATE attendance SET
          employee_uid = ?,
          id_number = ?,
          scanned_barcode = ?,
          clock_type = ?,
          clock_time = ?,
          date = ?,
          regular_hours = ?,
          overtime_hours = ?,
          is_late = ?,
          id_barcode = ?,
          is_synced = 1
        WHERE id = ?
      `);

      updateStmt.run(
        record.employee_uid,
        record.id_number || null,
        record.scanned_barcode || null,
        record.clock_type,
        record.clock_time,
        record.date,
        record.regular_hours || 0,
        record.overtime_hours || 0,
        record.is_late || 0,
        record.id_barcode || null,
        record.id
      );
      
      console.log(`✓ Updated existing record #${record.id}`);
    } else {
      // Insert new record
      const insertStmt = this.db.prepare(`
        INSERT INTO attendance (
          id, employee_uid, id_number, scanned_barcode, clock_type, clock_time, 
          date, regular_hours, overtime_hours, is_late, id_barcode, 
          is_synced, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `);

      insertStmt.run(
        record.id,
        record.employee_uid,
        record.id_number || null,
        record.scanned_barcode || null,
        record.clock_type,
        record.clock_time,
        record.date,
        record.regular_hours || 0,
        record.overtime_hours || 0,
        record.is_late || 0,
        record.id_barcode || null,
        record.created_at || new Date().toISOString()
      );
      
      console.log(`✓ Inserted new record #${record.id}`);
    }
  } catch (error) {
    console.error(`Error adding/updating record ${record.id}:`, error);
    throw error;
  }
}

  /**
   * Update record in local database
   */
  updateRecordLocally(record) {
    const stmt = this.db.prepare(`
      UPDATE attendance SET
        employee_uid = ?,
        id_number = ?,
        clock_type = ?,
        clock_time = ?,
        date = ?,
        regular_hours = ?,
        overtime_hours = ?,
        is_late = ?,
        is_synced = 1
      WHERE id = ?
    `);

    stmt.run(
      record.employee_uid,
      record.id_number,
      record.clock_type,
      record.clock_time,
      record.date,
      record.regular_hours || 0,
      record.overtime_hours || 0,
      record.is_late || 0,
      record.id
    );
  }

  /**
   * Delete record from local database
   */
  deleteRecordLocally(recordId) {
    const stmt = this.db.prepare('DELETE FROM attendance WHERE id = ?');
    stmt.run(recordId);
  }

  /**
   * Rebuild summaries for affected employee-date combinations
   */
  async rebuildAffectedSummaries(affectedDates) {
    let rebuilt = 0;
    const summariesToUpload = [];

    console.log(`\n🔄 Rebuilding summaries for ${affectedDates.size} employee-date combinations...`);

    for (const key of affectedDates) {
      const [employeeUid, date] = key.split('|');

      try {
        // Delete existing summary
        this.db.prepare('DELETE FROM daily_attendance_summary WHERE employee_uid = ? AND date = ?')
          .run(employeeUid, date);

        // Validate attendance data first
        const validator = new AttendanceValidationService(this.db);
        await validator.validateAttendanceData(
          date,
          date,
          parseInt(employeeUid),
          {
            autoCorrect: true,
            updateSyncStatus: false,
            validateStatistics: false,
            rebuildSummary: false,
            apply8HourRule: true
          }
        );

        // Create fresh summary
        const success = updateDailyAttendanceSummary(employeeUid, date, this.db);

        if (success) {
          rebuilt++;
          
          // Get the new summary for upload
          const summary = this.db.prepare(
            'SELECT * FROM daily_attendance_summary WHERE employee_uid = ? AND date = ?'
          ).get(employeeUid, date);

          if (summary) {
            summariesToUpload.push(summary);
            console.log(`  ✅ Rebuilt summary for employee ${employeeUid} on ${date}`);
          }
        }
      } catch (error) {
        console.error(`  ❌ Failed to rebuild summary for employee ${employeeUid} on ${date}:`, error.message);
      }
    }

    // Upload summaries to server
    const uploaded = await this.uploadSummariesToServer(summariesToUpload);

    return { rebuilt, uploaded };
  }

  /**
   * Upload summaries to server
   */
  async uploadSummariesToServer(summaries) {
    if (summaries.length === 0) return 0;

    try {
      const settings = this.db.prepare("SELECT value FROM settings WHERE key = 'server_url' LIMIT 1").get();
      if (!settings || !settings.value) {
        console.warn('⚠️ No server URL for uploading summaries');
        return 0;
      }

      const serverUrl = settings.value.replace(/\/api\/employees.*$/, '');
      const uploadUrl = `${serverUrl}/api/daily-summary/batch-upload`;

      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summaries }),
      });

      if (!response.ok) {
        console.warn(`⚠️ Failed to upload summaries: ${response.status}`);
        return 0;
      }

      const result = await response.json();

      if (result.success) {
        console.log(`  ✅ Uploaded ${result.success_count || summaries.length} summaries to server`);
        return result.success_count || summaries.length;
      }

      return 0;

    } catch (error) {
      console.error('  ❌ Error uploading summaries:', error.message);
      return 0;
    }
  }

  /**
   * Get cached comparison results
   */
  getCachedComparison() {
    return this.comparisonCache;
  }

  /**
   * Clear comparison cache
   */
  clearComparisonCache() {
    this.comparisonCache = null;
  }

  /**
   * EXISTING: Manual trigger for downloading server edits
   */
  async downloadServerEdits(silent = false) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      if (!silent) {
        console.log('==========================================');
        console.log('MANUAL CHECK: Checking SERVER for attendance edits...');
        console.log('==========================================');
      }

      const settings = this.db.prepare("SELECT value FROM settings WHERE key = 'server_url' LIMIT 1").get();

      if (!settings || !settings.value) {
        if (!silent) {
          console.warn('⚠️ No server URL configured');
        }
        return { success: false, downloaded: 0, applied: 0, deleted: 0 };
      }

      const serverUrl = settings.value.replace(/\/api\/employees.*$/, '');
      const syncUrl = `${serverUrl}/api/attendanceEdit`;

      const params = new URLSearchParams();
      if (this.lastSyncTimestamp) {
        params.append('since', this.lastSyncTimestamp);
      }
      params.append('limit', '1000');

      const fullUrl = `${syncUrl}?${params.toString()}`;

      if (!silent) {
        console.log(`Fetching from: ${fullUrl}`);
        console.log(`Since: ${this.lastSyncTimestamp || 'ALL RECORDS'}`);
      }

      const response = await fetch(fullUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const contentType = response.headers.get('content-type');
      
      if (!silent) {
        console.log(`Response status: ${response.status}`);
        console.log(`Content-Type: ${contentType}`);
      }

      const textResponse = await response.text();
      
      if (!silent) {
        console.log(`Response length: ${textResponse.length} bytes`);
        console.log(`Response preview: ${textResponse.substring(0, 200)}`);
      }

      if (!response.ok) {
        let errorMessage = `Server responded with ${response.status}: ${response.statusText}`;
        
        if (textResponse.includes('<html>') || textResponse.includes('<!DOCTYPE') || textResponse.includes('<br />')) {
          console.error('Server returned HTML error page:', textResponse.substring(0, 500));
          errorMessage = `Server error: The endpoint returned an HTML error page. Status: ${response.status}. This usually means:\n`;
          errorMessage += `1. The endpoint doesn't exist\n`;
          errorMessage += `2. There's a PHP error on the server\n`;
          errorMessage += `3. Server routing is misconfigured\n\n`;
          errorMessage += `Response preview: ${textResponse.substring(0, 200)}`;
        } else if (contentType && contentType.includes('application/json')) {
          try {
            const errorData = JSON.parse(textResponse);
            errorMessage = errorData.error || errorData.message || errorMessage;
          } catch (e) {
            errorMessage = `${errorMessage}. Invalid JSON response.`;
          }
        } else {
          errorMessage = `${errorMessage}. Response: ${textResponse.substring(0, 200)}`;
        }
        
        throw new Error(errorMessage);
      }

      if (!contentType || !contentType.includes('application/json')) {
        console.error('Non-JSON response received:', textResponse.substring(0, 500));
        
        if (textResponse.includes('<html>') || textResponse.includes('<!DOCTYPE') || textResponse.includes('<br />')) {
          throw new Error(`Server returned HTML instead of JSON. The /api/attendanceEdit endpoint might not exist on your server. Response: ${textResponse.substring(0, 200)}`);
        }
        
        throw new Error(`Server returned non-JSON response. Content-Type: ${contentType || 'none'}. Response: ${textResponse.substring(0, 200)}`);
      }

      let result;
      try {
        result = JSON.parse(textResponse);
      } catch (parseError) {
        console.error('JSON parse error:', parseError);
        console.error('Response text:', textResponse);
        throw new Error(`Failed to parse server response as JSON: ${parseError.message}`);
      }

      if (!result.success) {
        throw new Error(result.error || 'Server returned error');
      }

      const { edited = [], deleted = [] } = result.data || {};

      if (!silent) {
        console.log(`📥 Server returned: ${edited.length} edited, ${deleted.length} deleted`);
      }

      if (edited.length === 0 && deleted.length === 0) {
        if (!silent) {
          console.log('✓ No server edits to download');
        }
        return { success: true, downloaded: 0, applied: 0, deleted: 0 };
      }

      const applyResult = await this.applyServerEdits(edited, deleted);

      if (applyResult.applied > 0 || applyResult.deleted > 0) {
        await this.markRecordsAsSyncedOnServer(edited, deleted);

        if (applyResult.summariesRegenerated > 0 && applyResult.affectedDates.size > 0) {
          const uploadCount = await this.uploadRegeneratedSummaries(applyResult.affectedDates);
          applyResult.summariesUploaded = uploadCount;
        }

        broadcastUpdate('server_edits_applied', {
          updated: applyResult.applied,
          deleted: applyResult.deleted,
          validated: applyResult.validated || 0,
          corrected: applyResult.corrected || 0,
          summariesRegenerated: applyResult.summariesRegenerated || 0,
          summariesUploaded: applyResult.summariesUploaded || 0,
          timestamp: new Date().toISOString(),
          message: `${applyResult.applied} records updated, ${applyResult.deleted} deleted, ${applyResult.corrected} corrected, ${applyResult.summariesRegenerated} summaries regenerated`
        });

        console.log('📡 WebSocket update broadcast sent');
      }

      this.lastSyncTimestamp = result.data.timestamp || new Date().toISOString();

      if (!silent) {
        console.log(`✅ Applied ${applyResult.applied} edits and ${applyResult.deleted} deletions`);
        console.log(`✅ Validated and corrected ${applyResult.corrected || 0} records`);
        console.log(`✅ Regenerated ${applyResult.summariesRegenerated || 0} daily summaries`);
        console.log(`✅ Uploaded ${applyResult.summariesUploaded || 0} summaries to server`);
        console.log('==========================================');
      }

      this.recordSyncEvent({
        success: true,
        downloaded: edited.length + deleted.length,
        applied: applyResult.applied,
        deleted: applyResult.deleted,
        validated: applyResult.validated || 0,
        corrected: applyResult.corrected || 0,
        summariesRegenerated: applyResult.summariesRegenerated || 0,
        summariesUploaded: applyResult.summariesUploaded || 0
      });

      return {
        success: true,
        downloaded: edited.length + deleted.length,
        applied: applyResult.applied,
        deleted: applyResult.deleted,
        validated: applyResult.validated || 0,
        corrected: applyResult.corrected || 0,
        summariesRegenerated: applyResult.summariesRegenerated || 0,
        summariesUploaded: applyResult.summariesUploaded || 0,
        errors: applyResult.errors
      };

    } catch (error) {
      console.error('❌ Error downloading server edits:', error);

      this.recordSyncEvent({
        success: false,
        downloaded: 0,
        applied: 0,
        deleted: 0,
        error: error.message
      });

      return {
        success: false,
        downloaded: 0,
        applied: 0,
        deleted: 0,
        error: error.message
      };
    }
  }

  async applyServerEdits(editedRecords, deletedRecords) {
    let applied = 0;
    let deleted = 0;
    const errors = [];
    const affectedEmployeeDates = new Set();

    const upsertStmt = this.db.prepare(`
      INSERT INTO attendance (
        id, employee_uid, id_number, clock_type, clock_time, date,
        regular_hours, overtime_hours, is_late, is_synced, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        employee_uid = excluded.employee_uid,
        id_number = excluded.id_number,
        clock_type = excluded.clock_type,
        clock_time = excluded.clock_time,
        date = excluded.date,
        regular_hours = excluded.regular_hours,
        overtime_hours = excluded.overtime_hours,
        is_late = excluded.is_late,
        is_synced = 1
    `);

    const deleteStmt = this.db.prepare(`DELETE FROM attendance WHERE id = ?`);
    const deleteSummaryStmt = this.db.prepare(`
      DELETE FROM daily_attendance_summary 
      WHERE employee_uid = ? AND date = ?
    `);

    console.log(`\n  🔍 STEP 1: Collecting affected employee-date combinations...`);

    for (const record of editedRecords) {
      affectedEmployeeDates.add(`${record.employee_uid}|${record.date}`);
    }

    for (const recordId of deletedRecords) {
      try {
        const existingRecord = this.db.prepare(
          'SELECT employee_uid, date FROM attendance WHERE id = ?'
        ).get(recordId);

        if (existingRecord) {
          affectedEmployeeDates.add(`${existingRecord.employee_uid}|${existingRecord.date}`);
        }
      } catch (error) {
        console.error(`  ❌ Error finding record #${recordId}:`, error.message);
      }
    }

    console.log(`  ✓ Found ${affectedEmployeeDates.size} affected employee-date combinations`);

    const transaction = this.db.transaction(() => {
      console.log(`\n  🗑️ STEP 2: Syncing local summary deletions (${affectedEmployeeDates.size} summaries)...`);
      console.log(`  ℹ️ Note: Server already deleted these summaries when attendance was edited`);

      let deletedCount = 0;
      let alreadyDeletedCount = 0;

      for (const key of affectedEmployeeDates) {
        const [employeeUid, date] = key.split('|');
        try {
          const existingSummary = this.db.prepare(
            'SELECT id, regular_hours, overtime_hours, total_hours FROM daily_attendance_summary WHERE employee_uid = ? AND date = ?'
          ).get(employeeUid, date);

          if (existingSummary) {
            console.log(`  📊 Deleting local summary for employee ${employeeUid} on ${date}:`);
            console.log(`     ID: ${existingSummary.id}, Regular=${existingSummary.regular_hours}h, OT=${existingSummary.overtime_hours}h, Total=${existingSummary.total_hours}h`);

            const result = deleteSummaryStmt.run(employeeUid, date);
            if (result.changes > 0) {
              deletedCount++;
              console.log(`  ✅ Deleted local summary`);
            }
          } else {
            alreadyDeletedCount++;
            console.log(`  ✓ Summary already deleted for employee ${employeeUid} on ${date} (server deleted it)`);
          }
        } catch (error) {
          console.error(`  ❌ Failed to delete summary for ${employeeUid} on ${date}:`, error.message);
        }
      }

      console.log(`  ✅ Deleted ${deletedCount} local summaries, ${alreadyDeletedCount} already synced with server`);

      console.log(`\n  📝 STEP 3: Applying ${editedRecords.length} attendance edits...`);

      for (const record of editedRecords) {
        try {
          const result = upsertStmt.run(
            record.id,
            record.employee_uid,
            record.id_number,
            record.clock_type,
            record.clock_time,
            record.date,
            record.regular_hours || 0,
            record.overtime_hours || 0,
            record.is_late || 0,
            1,
            record.created_at || new Date().toISOString()
          );

          if (result.changes > 0) {
            applied++;
            console.log(`  ✓ Applied edit for attendance #${record.id}: ${record.clock_type} at ${record.clock_time} (Regular: ${record.regular_hours || 0}h, OT: ${record.overtime_hours || 0}h)`);
          }
        } catch (error) {
          const msg = `Failed to apply edit #${record.id}: ${error.message}`;
          errors.push(msg);
          console.error(`  ❌ ${msg}`);
        }
      }

      console.log(`\n  🗑️ STEP 4: Applying ${deletedRecords.length} attendance deletions...`);

      for (const recordId of deletedRecords) {
        try {
          const result = deleteStmt.run(recordId);

          if (result.changes > 0) {
            deleted++;
            console.log(`  ✓ Deleted attendance #${recordId}`);
          }
        } catch (error) {
          const msg = `Failed to delete #${recordId}: ${error.message}`;
          errors.push(msg);
          console.error(`  ❌ ${msg}`);
        }
      }
    });

    try {
      transaction();

      let validated = 0;
      let corrected = 0;

      if (affectedEmployeeDates.size > 0) {
        console.log(`\n  🔍 STEP 5: Validating attendance data for ${affectedEmployeeDates.size} employee-date combinations...`);

        const validator = new AttendanceValidationService(this.db);

        for (const key of affectedEmployeeDates) {
          const [employeeUid, date] = key.split('|');

          try {
            const remainingCount = this.db.prepare(
              'SELECT COUNT(*) as count FROM attendance WHERE employee_uid = ? AND date = ?'
            ).get(employeeUid, date).count;

            if (remainingCount === 0) {
              console.log(`  ⚠️ No attendance records for employee ${employeeUid} on ${date} - skipping validation`);
              continue;
            }

            const validationResult = await validator.validateAttendanceData(
              date,
              date,
              parseInt(employeeUid),
              {
                autoCorrect: true,
                updateSyncStatus: false,
                validateStatistics: false,
                rebuildSummary: false,
                apply8HourRule: true
              }
            );

            validated++;
            corrected += validationResult.correctedRecords || 0;

            if (validationResult.correctedRecords > 0) {
              console.log(`  ✅ Validated employee ${employeeUid} on ${date}: ${validationResult.correctedRecords} corrections applied to attendance records`);

              if (validationResult.corrections && validationResult.corrections.length > 0) {
                validationResult.corrections.forEach(correction => {
                  console.log(`     Record #${correction.recordId}: Regular ${correction.originalRegular}h→${correction.correctedRegular}h, OT ${correction.originalOvertime}h→${correction.correctedOvertime}h`);
                });
              }
            } else {
              console.log(`  ✓ Validated employee ${employeeUid} on ${date}: All records valid`);
            }
          } catch (validationError) {
            const msg = `Failed to validate employee ${employeeUid} on ${date}: ${validationError.message}`;
            errors.push(msg);
            console.error(`  ❌ ${msg}`);
          }
        }

        console.log(`  ✅ Validation complete: ${validated} employee-dates validated, ${corrected} records corrected in attendance table`);
        console.log(`  📊 The attendance records now have CORRECT hours that will be used for summary generation`);
      }

      let summariesRegenerated = 0;

      if (affectedEmployeeDates.size > 0) {
        console.log(`\n  🔄 STEP 6: Creating FRESH ${affectedEmployeeDates.size} daily summaries from validated data...`);

        for (const key of affectedEmployeeDates) {
          const [employeeUid, date] = key.split('|');

          try {
            const remainingCount = this.db.prepare(
              'SELECT COUNT(*) as count FROM attendance WHERE employee_uid = ? AND date = ?'
            ).get(employeeUid, date).count;

            if (remainingCount === 0) {
              console.log(`  ℹ️ No attendance records for employee ${employeeUid} on ${date} (no summary needed)`);
              continue;
            }

            const existingSummaryCheck = this.db.prepare(
              'SELECT id FROM daily_attendance_summary WHERE employee_uid = ? AND date = ?'
            ).get(employeeUid, date);

            if (existingSummaryCheck) {
              console.warn(`  ⚠️ WARNING: Summary still exists for employee ${employeeUid} on ${date}! Force deleting...`);
              this.db.prepare('DELETE FROM daily_attendance_summary WHERE employee_uid = ? AND date = ?')
                .run(employeeUid, date);
              console.log(`  ✅ Force deleted existing summary`);
            }

            const success = updateDailyAttendanceSummary(employeeUid, date, this.db);

            if (success) {
              summariesRegenerated++;

              const newSummary = this.db.prepare(
                'SELECT morning_hours, afternoon_hours, evening_hours, overtime_hours, total_hours FROM daily_attendance_summary WHERE employee_uid = ? AND date = ?'
              ).get(employeeUid, date);

              if (newSummary) {
                console.log(`  ✅ Created FRESH summary for employee ${employeeUid} on ${date}:`);
                console.log(`     Morning: ${newSummary.morning_hours}h, Afternoon: ${newSummary.afternoon_hours}h, Evening: ${newSummary.evening_hours}h, OT: ${newSummary.overtime_hours}h, Total: ${newSummary.total_hours}h`);
              }
            } else {
              const msg = `Failed to create summary for employee ${employeeUid} on ${date}`;
              errors.push(msg);
              console.error(`  ❌ ${msg}`);
            }
          } catch (summaryError) {
            const msg = `Failed to process summary for employee ${employeeUid} on ${date}: ${summaryError.message}`;
            errors.push(msg);
            console.error(`  ❌ ${msg}`);
          }
        }

        console.log(`  ✅ Successfully created ${summariesRegenerated} FRESH daily summaries from validated data`);
      }

      return {
        applied,
        deleted,
        validated,
        corrected,
        summariesRegenerated,
        affectedDates: affectedEmployeeDates,
        errors
      };

    } catch (error) {
      errors.push(`Transaction failed: ${error.message}`);
      console.error('❌ Transaction error:', error);
      return {
        applied: 0,
        deleted: 0,
        validated: 0,
        corrected: 0,
        summariesRegenerated: 0,
        affectedDates: new Set(),
        errors
      };
    }
  }

  async uploadRegeneratedSummaries(affectedDates) {
    if (affectedDates.size === 0) {
      return 0;
    }

    console.log(`\n  📤 STEP 7: Uploading ${affectedDates.size} regenerated summaries to server...`);

    try {
      const settings = this.db.prepare("SELECT value FROM settings WHERE key = 'server_url' LIMIT 1").get();

      if (!settings || !settings.value) {
        console.warn('⚠️ No server URL configured for uploading summaries');
        return 0;
      }

      const serverUrl = settings.value.replace(/\/api\/employees.*$/, '');
      const uploadUrl = `${serverUrl}/api/daily-summary/batch-upload`;

      const summariesToUpload = [];

      for (const key of affectedDates) {
        const [employeeUid, date] = key.split('|');

        try {
          const summary = this.db.prepare(`
            SELECT * FROM daily_attendance_summary
            WHERE employee_uid = ? AND date = ?
          `).get(employeeUid, date);

          if (summary) {
            summariesToUpload.push(summary);
          }
        } catch (error) {
          console.error(`  ❌ Error fetching summary for employee ${employeeUid} on ${date}:`, error.message);
        }
      }

      if (summariesToUpload.length === 0) {
        console.log('  ℹ️ No summaries to upload');
        return 0;
      }

      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summaries: summariesToUpload }),
      });

      if (!response.ok) {
        console.warn(`  ⚠️ Failed to upload summaries: ${response.status}`);
        return 0;
      }

      const result = await response.json();

      if (result.success) {
        console.log(`  ✅ Uploaded ${result.success_count || summariesToUpload.length} summaries to server`);
        return result.success_count || summariesToUpload.length;
      }

      return 0;

    } catch (error) {
      console.error('  ❌ Error uploading summaries:', error.message);
      return 0;
    }
  }

  async markRecordsAsSyncedOnServer(editedRecords, deletedRecords) {
    try {
      const settings = this.db.prepare("SELECT value FROM settings WHERE key = 'server_url' LIMIT 1").get();

      if (!settings || !settings.value) {
        console.warn('⚠️ No server URL for marking synced');
        return;
      }

      const serverUrl = settings.value.replace(/\/api\/employees.*$/, '');
      const markSyncedUrl = `${serverUrl}/api/attendanceEdit/mark-synced`;

      const editedIds = editedRecords.map(r => r.id);
      const deletedIds = deletedRecords;

      const response = await fetch(markSyncedUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editedIds, deletedIds }),
      });

      if (!response.ok) {
        console.warn(`⚠️ Failed to mark as synced: ${response.status}`);
        return;
      }

      const result = await response.json();

      if (result.success) {
        console.log(`  ✓ Marked ${editedIds.length} edits + ${deletedIds.length} deletions as synced on server`);
      }
    } catch (error) {
      console.warn('⚠️ Error marking records as synced:', error.message);
    }
  }

  async forceSyncNow() {
    console.log('🔄 Manual sync triggered by user');
    return await this.downloadServerEdits(false);
  }

  getLastSyncInfo() {
    try {
      return {
        success: true,
        lastSyncTimestamp: this.lastSyncTimestamp,
        isInitialized: this.isInitialized,
        syncMode: 'manual',
        syncHistory: this.syncHistory.slice(0, 5)
      };
    } catch (error) {
      console.error('Error getting last sync info:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  getSyncHistory(limit = 10) {
    try {
      const historyLimit = Math.min(limit, this.syncHistory.length);
      return this.syncHistory.slice(0, historyLimit);
    } catch (error) {
      console.error('Error getting sync history:', error);
      return [];
    }
  }

  recordSyncEvent(result) {
    const event = {
      timestamp: new Date().toISOString(),
      success: result.success,
      downloaded: result.downloaded || 0,
      applied: result.applied || 0,
      deleted: result.deleted || 0,
      validated: result.validated || 0,
      corrected: result.corrected || 0,
      summariesRegenerated: result.summariesRegenerated || 0,
      summariesUploaded: result.summariesUploaded || 0,
      error: result.error || null
    };

    this.syncHistory.unshift(event);

    if (this.syncHistory.length > this.maxHistorySize) {
      this.syncHistory = this.syncHistory.slice(0, this.maxHistorySize);
    }
  }
}

// Create singleton instance
const serverEditSyncService = new ServerEditSyncService();

module.exports = {
  ServerEditSyncService,
  serverEditSyncService,
  // New comparison methods
  compareServerAndLocal: async (startDate, endDate) => {
    return await serverEditSyncService.compareServerAndLocal(startDate, endDate);
  },
  applyComparisonActions: async (actions) => {
    return await serverEditSyncService.applyComparisonActions(actions);
  },
  getCachedComparison: () => {
    return serverEditSyncService.getCachedComparison();
  },
  clearComparisonCache: () => {
    serverEditSyncService.clearComparisonCache();
  },
  // Existing exports
  downloadServerEdits: async (silent = false) => {
    return await serverEditSyncService.downloadServerEdits(silent);
  },
  checkServerEdits: async (silent = false) => {
    return await serverEditSyncService.downloadServerEdits(silent);
  },
  initializeService: async () => {
    return await serverEditSyncService.initialize();
  },
  forceSyncNow: async () => {
    return await serverEditSyncService.forceSyncNow();
  },
  getLastSyncInfo: () => {
    return serverEditSyncService.getLastSyncInfo();
  },
  getSyncHistory: (limit = 10) => {
    return serverEditSyncService.getSyncHistory(limit);
  }
};