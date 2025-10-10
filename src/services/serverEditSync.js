// services/serverEditSync.js - Download server edits to local (with WebSocket and Validation)
const { getDatabase, updateDailyAttendanceSummary } = require('../database/setup');
const { broadcastUpdate } = require('./websocket');
const { AttendanceValidationService } = require('./validateTime');

class ServerEditSyncService {
  constructor() {
    this.db = null;
    this.lastSyncTimestamp = null;
    this.syncInterval = 2 * 60 * 1000;
    this.syncTimer = null;
    this.isInitialized = false;
    this.syncHistory = [];
    this.maxHistorySize = 50;
  }

  async initialize() {
    try {
      this.db = getDatabase();

      if (!this.db) {
        throw new Error('Database not available');
      }

      this.lastSyncTimestamp = null;
      this.isInitialized = true;

      console.log('✓ Server Edit Sync Service initialized');

      return { success: true };
    } catch (error) {
      console.error('Failed to initialize ServerEditSyncService:', error);
      return { success: false, error: error.message };
    }
  }

  startAutoSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }

    console.log('==========================================');
    console.log('ServerEditSyncService.startAutoSync() CALLED');
    console.log(`Sync interval: ${this.syncInterval / 60000} minutes`);
    console.log('==========================================');

    // Initial sync after 30 seconds
    setTimeout(() => {
      console.log('>>> TRIGGERING INITIAL SYNC (30s delay) <<<');
      this.downloadServerEdits(true);
    }, 30000);

    // Regular sync every 2 minutes
    this.syncTimer = setInterval(() => {
      console.log('>>> TRIGGERING SCHEDULED SYNC <<<');
      this.downloadServerEdits(true);
    }, this.syncInterval);

    console.log('✓ Auto-sync timer started');
  }

  stopAutoSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
      console.log('Auto-sync stopped');
    }
  }

  async downloadServerEdits(silent = false) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      if (!silent) {
        console.log('==========================================');
        console.log('Checking SERVER for attendance edits...');
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
        timeout: 30000,
      });

      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();

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

      // Apply edits to local database
      const applyResult = await this.applyServerEdits(edited, deleted);

      // Mark records as synced on server
      if (applyResult.applied > 0 || applyResult.deleted > 0) {
        await this.markRecordsAsSyncedOnServer(edited, deleted);

        // Upload regenerated summaries back to server
        if (applyResult.summariesRegenerated > 0 && applyResult.affectedDates.size > 0) {
          await this.uploadRegeneratedSummaries(applyResult.affectedDates);
        }

        // ✨ BROADCAST WEBSOCKET UPDATE ✨
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

      // Update last sync timestamp
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

    // ✨ STEP 1: Collect all affected employee-date combinations BEFORE making changes (OUTSIDE transaction)
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

    // ✨ STEP 2: Delete ALL affected daily summaries FIRST (INSIDE transaction)
    const transaction = this.db.transaction(() => {
      console.log(`\n  🗑️ STEP 2: Deleting ${affectedEmployeeDates.size} existing daily summaries...`);
      
      let deletedCount = 0;
      for (const key of affectedEmployeeDates) {
        const [employeeUid, date] = key.split('|');
        try {
          // Check and log existing summary before deletion
          const existingSummary = this.db.prepare(
            'SELECT id, regular_hours, overtime_hours, total_hours FROM daily_attendance_summary WHERE employee_uid = ? AND date = ?'
          ).get(employeeUid, date);
          
          if (existingSummary) {
            console.log(`  📊 Deleting OLD summary for employee ${employeeUid} on ${date}:`);
            console.log(`     ID: ${existingSummary.id}, Regular=${existingSummary.regular_hours}h, OT=${existingSummary.overtime_hours}h, Total=${existingSummary.total_hours}h`);
            
            const result = deleteSummaryStmt.run(employeeUid, date);
            if (result.changes > 0) {
              deletedCount++;
              console.log(`  ✅ Deleted summary successfully`);
            }
          } else {
            console.log(`  ℹ️ No existing summary for employee ${employeeUid} on ${date}`);
          }
        } catch (error) {
          console.error(`  ❌ Failed to delete summary for ${employeeUid} on ${date}:`, error.message);
        }
      }
      
      console.log(`  ✅ Deleted ${deletedCount} daily summaries`);

      // ✨ STEP 3: Apply edits to attendance records
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

      // ✨ STEP 4: Apply deletions to attendance records
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
      // Execute the transaction
      transaction();

      // ✨ STEP 5: Validate and correct attendance records BEFORE regenerating summaries
let validated = 0;
let corrected = 0;

if (affectedEmployeeDates.size > 0) {
  console.log(`\n  🔍 STEP 5: Validating attendance data for ${affectedEmployeeDates.size} employee-date combinations...`);

  const validator = new AttendanceValidationService(this.db);
  
  for (const key of affectedEmployeeDates) {
    const [employeeUid, date] = key.split('|');
    
    try {
      // Check if there are any remaining attendance records first
      const remainingCount = this.db.prepare(
        'SELECT COUNT(*) as count FROM attendance WHERE employee_uid = ? AND date = ?'
      ).get(employeeUid, date).count;

      if (remainingCount === 0) {
        console.log(`  ⚠️ No attendance records for employee ${employeeUid} on ${date} - skipping validation`);
        continue;
      }

      // Validate this employee's attendance for this date
      // The validator ALREADY updates the attendance records with corrected hours
      const validationResult = await validator.validateAttendanceData(
        date,
        date,
        parseInt(employeeUid),
        {
          autoCorrect: true,              // ✅ This makes it UPDATE the attendance records
          updateSyncStatus: false,         // Don't reset sync status
          validateStatistics: false,       // Skip statistics validation
          rebuildSummary: false,           // We'll rebuild summaries in STEP 6
          apply8HourRule: true             // Apply 8-hour rule
        }
      );

      validated++;
      corrected += validationResult.correctedRecords || 0;

      if (validationResult.correctedRecords > 0) {
        console.log(`  ✅ Validated employee ${employeeUid} on ${date}: ${validationResult.correctedRecords} corrections applied to attendance records`);
        
        // Log the specific corrections that were made
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

      // ✨ STEP 6: Create FRESH daily summaries from VALIDATED attendance data
      let summariesRegenerated = 0;
      
      if (affectedEmployeeDates.size > 0) {
        console.log(`\n  🔄 STEP 6: Creating FRESH ${affectedEmployeeDates.size} daily summaries from validated data...`);

        for (const key of affectedEmployeeDates) {
          const [employeeUid, date] = key.split('|');
          
          try {
            // Check if there are any remaining attendance records
            const remainingCount = this.db.prepare(
              'SELECT COUNT(*) as count FROM attendance WHERE employee_uid = ? AND date = ?'
            ).get(employeeUid, date).count;

            if (remainingCount === 0) {
              console.log(`  ℹ️ No attendance records for employee ${employeeUid} on ${date} (no summary needed)`);
              continue;
            }

            // CRITICAL: Final check to ensure no summary exists
            const existingSummaryCheck = this.db.prepare(
              'SELECT id FROM daily_attendance_summary WHERE employee_uid = ? AND date = ?'
            ).get(employeeUid, date);
            
            if (existingSummaryCheck) {
              console.warn(`  ⚠️ WARNING: Summary still exists for employee ${employeeUid} on ${date}! Force deleting...`);
              this.db.prepare('DELETE FROM daily_attendance_summary WHERE employee_uid = ? AND date = ?')
                .run(employeeUid, date);
              console.log(`  ✅ Force deleted existing summary`);
            }

            // Create fresh summary from validated attendance data
            const success = updateDailyAttendanceSummary(employeeUid, date, this.db);
            
            if (success) {
              summariesRegenerated++;
              
              // Verify the newly created summary
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

      // Collect all regenerated summaries
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

      // Upload to server
      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summaries: summariesToUpload }),
        timeout: 30000,
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
        timeout: 30000,
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
    console.log('🔄 Force sync triggered by user');
    return await this.downloadServerEdits(false);
  }

  getLastSyncInfo() {
    try {
      return {
        success: true,
        lastSyncTimestamp: this.lastSyncTimestamp,
        isInitialized: this.isInitialized,
        syncInterval: this.syncInterval,
        autoSyncRunning: this.syncTimer !== null
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

    // Add to beginning of array
    this.syncHistory.unshift(event);

    // Keep only the most recent entries
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
  downloadServerEdits: async (silent = false) => {
    return await serverEditSyncService.downloadServerEdits(silent);
  },
  checkServerEdits: async (silent = false) => {
    return await serverEditSyncService.downloadServerEdits(silent);
  },
  startAutoSync: () => {
    return serverEditSyncService.startAutoSync();
  },
  stopAutoSync: () => {
    return serverEditSyncService.stopAutoSync();
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