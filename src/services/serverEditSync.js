// services/serverEditSync.js - Download server edits to local (simplified)
const { getDatabase, updateDailyAttendanceSummary } = require('../database/setup');

class ServerEditSyncService {
  constructor() {
    this.db = null;
    this.lastSyncTimestamp = null;
    this.syncInterval = 2 * 60 * 1000; // Check every 2 minutes
    this.syncTimer = null;
    this.isInitialized = false;
  }

  async initialize() {
    try {
      this.db = getDatabase();
      
      if (!this.db) {
        throw new Error('Database not available');
      }

      // Initialize last sync timestamp to null (will fetch all records on first sync)
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

  /**
   * Download server edits and apply to local database
   * This checks the server for records with is_synced = 0
   */
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

      // Get server URL from settings
      const settings = this.db.prepare("SELECT value FROM settings WHERE key = 'server_url' LIMIT 1").get();
      
      if (!settings || !settings.value) {
        if (!silent) {
          console.warn('⚠️ No server URL configured');
        }
        return { success: false, downloaded: 0, applied: 0, deleted: 0 };
      }

      // Construct API endpoint
      const serverUrl = settings.value.replace(/\/api\/employees.*$/, '');
      const syncUrl = `${serverUrl}/api/attendanceEdit`;

      // Build query parameters
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

      // Fetch from server
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
      
      // Mark records as synced on server (acknowledge receipt)
      if (applyResult.applied > 0 || applyResult.deleted > 0) {
        await this.markRecordsAsSyncedOnServer(edited, deleted);
      }
      
      // Update last sync timestamp
      this.lastSyncTimestamp = result.data.timestamp || new Date().toISOString();

      if (!silent) {
        console.log(`✅ Applied ${applyResult.applied} edits and ${applyResult.deleted} deletions`);
        console.log('==========================================');
      }

      return {
        success: true,
        downloaded: edited.length + deleted.length,
        applied: applyResult.applied,
        deleted: applyResult.deleted,
        errors: applyResult.errors
      };

    } catch (error) {
      console.error('❌ Error downloading server edits:', error);
      
      return {
        success: false,
        downloaded: 0,
        applied: 0,
        deleted: 0,
        error: error.message
      };
    }
  }

  /**
   * Apply server edits to local database
   */
  async applyServerEdits(editedRecords, deletedRecords) {
    let applied = 0;
    let deleted = 0;
    const errors = [];
    const affectedEmployeeDates = new Set();

    // Prepare statements - FIXED: Removed extra comma before closing parenthesis
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

    const transaction = this.db.transaction(() => {
      // Apply edits (upsert)
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
            1, // is_synced
            record.created_at || new Date().toISOString()
          );

          if (result.changes > 0) {
            applied++;
            affectedEmployeeDates.add(`${record.employee_uid}|${record.date}`);
            console.log(`  ✓ Applied edit for attendance #${record.id}`);
          }
        } catch (error) {
          const msg = `Failed to apply edit #${record.id}: ${error.message}`;
          errors.push(msg);
          console.error(`  ❌ ${msg}`);
        }
      }

      // Apply deletions
      for (const recordId of deletedRecords) {
        try {
          // Get record info before deleting
          const existingRecord = this.db.prepare(
            'SELECT employee_uid, date FROM attendance WHERE id = ?'
          ).get(recordId);
          
          if (existingRecord) {
            const result = deleteStmt.run(recordId);

            if (result.changes > 0) {
              deleted++;
              affectedEmployeeDates.add(`${existingRecord.employee_uid}|${existingRecord.date}`);
              console.log(`  ✓ Deleted attendance #${recordId}`);
            }
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
      
      // Rebuild daily summaries for affected employee-dates
      if (affectedEmployeeDates.size > 0) {
        console.log(`  🔄 Rebuilding ${affectedEmployeeDates.size} daily summaries...`);
        
        for (const key of affectedEmployeeDates) {
          const [employeeUid, date] = key.split('|');
          try {
            updateDailyAttendanceSummary(employeeUid, date, this.db);
          } catch (summaryError) {
            const msg = `Failed to update summary for ${employeeUid} on ${date}: ${summaryError.message}`;
            errors.push(msg);
            console.error(`  ❌ ${msg}`);
          }
        }
      }
      
    } catch (error) {
      errors.push(`Transaction failed: ${error.message}`);
      console.error('❌ Transaction error:', error);
    }

    return { applied, deleted, errors };
  }

  /**
   * Mark records as synced on server after successful local update
   */
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
}

// Create singleton instance
const serverEditSyncService = new ServerEditSyncService();

module.exports = {
  ServerEditSyncService,
  serverEditSyncService,
  
  // Main function: Download server edits
  downloadServerEdits: async (silent = false) => {
    return await serverEditSyncService.downloadServerEdits(silent);
  },
  
  // Start/stop auto-sync
  startAutoSync: () => {
    return serverEditSyncService.startAutoSync();
  },
  
  stopAutoSync: () => {
    return serverEditSyncService.stopAutoSync();
  },
  
  // Initialize service
  initializeService: async () => {
    return await serverEditSyncService.initialize();
  },
  
  // Force sync now
  forceSyncNow: async () => {
    return await serverEditSyncService.forceSyncNow();
  }
};