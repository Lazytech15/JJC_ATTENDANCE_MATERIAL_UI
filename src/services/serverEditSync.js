// services/serverEditSync.js - FIXED VERSION
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

      // Create edit_sync_log table if it doesn't exist
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS edit_sync_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sync_timestamp TEXT NOT NULL,
          records_checked INTEGER DEFAULT 0,
          records_updated INTEGER DEFAULT 0,
          records_deleted INTEGER DEFAULT 0,
          records_uploaded INTEGER DEFAULT 0,
          errors TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // Get last sync timestamp
      const lastSync = this.db.prepare(`
        SELECT sync_timestamp 
        FROM edit_sync_log 
        ORDER BY id DESC 
        LIMIT 1
      `).get();

      this.lastSyncTimestamp = lastSync ? lastSync.sync_timestamp : null;
      this.isInitialized = true;

      console.log('✓ Server Edit Sync Service initialized');
      console.log(`Last sync: ${this.lastSyncTimestamp || 'Never'}`);

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
    console.log(`ServerEditSyncService.startAutoSync() CALLED`);
    console.log(`Sync interval: ${this.syncInterval / 60000} minutes`);
    console.log('==========================================');

    // Initial sync after 30 seconds
    setTimeout(() => {
      console.log('>>> TRIGGERING INITIAL SYNC (30s delay) <<<');
      this.performFullSync(true);
    }, 30000);

    // Regular sync
    this.syncTimer = setInterval(() => {
      console.log('>>> TRIGGERING SCHEDULED SYNC <<<');
      this.performFullSync(true);
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
   * FIXED: Perform full bidirectional sync
   * CORRECT ORDER: Download from server FIRST, then upload local changes
   */
  async performFullSync(silent = false) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      console.log('==========================================');
      console.log('ServerEditSyncService.performFullSync() CALLED');
      console.log('Silent mode:', silent);
      console.log('==========================================');
      
      if (!silent) {
        console.log('Starting full bidirectional sync...');
      }

      // STEP 1: Download server edits to local (CLOUD → LOCAL)
      if (!silent) {
        console.log('Step 1: Downloading from server (cloud → local)...');
      }
      const downloadResult = await this.downloadServerEdits(silent);
      
      // STEP 2: Upload unsynced local records to server (LOCAL → CLOUD)
      if (!silent) {
        console.log('Step 2: Uploading to server (local → cloud)...');
      }
      const uploadResult = await this.uploadUnsyncedRecords(silent);

      // Combine results
      const totalUpdated = downloadResult.updated + uploadResult.uploaded;
      const totalDeleted = downloadResult.deleted;

      // Log combined sync
      this.logSync(
        downloadResult.checked,
        downloadResult.updated,
        downloadResult.deleted,
        uploadResult.uploaded,
        [...(uploadResult.errors || []), ...(downloadResult.errors || [])]
      );

      if (!silent) {
        console.log(`✓ Full sync complete:`);
        console.log(`  - Downloaded: ${downloadResult.updated} edits, ${downloadResult.deleted} deletions`);
        console.log(`  - Uploaded: ${uploadResult.uploaded} new records`);
      }

      return {
        success: true,
        downloaded: {
          updated: downloadResult.updated,
          deleted: downloadResult.deleted
        },
        uploaded: uploadResult.uploaded,
        message: `Downloaded ${downloadResult.updated} edits + ${downloadResult.deleted} deletions, Uploaded ${uploadResult.uploaded} new records`
      };

    } catch (error) {
      console.error('Error in full sync:', error);
      this.logSync(0, 0, 0, 0, [error.message]);
      
      return {
        success: false,
        error: error.message,
        downloaded: { updated: 0, deleted: 0 },
        uploaded: 0
      };
    }
  }

  /**
   * FIXED: Download server edits to local
   * This checks the CLOUD database for unsynced records
   */
  async downloadServerEdits(silent = false) {
    try {
      console.log('>>> downloadServerEdits() CALLED <<<');
      
      if (!silent) {
        console.log('Checking SERVER for attendance edits (cloud database)...');
      }

      // Get server URL from settings
      const settings = this.db.prepare("SELECT value FROM settings WHERE key = 'server_url' LIMIT 1").get();
      
      if (!settings || !settings.value) {
        if (!silent) {
          console.warn('No server URL configured');
        }
        return { success: false, checked: 0, updated: 0, deleted: 0, errors: ['Server URL not configured'] };
      }

      // Extract base URL and construct the attendanceEdit endpoint
      const serverUrl = settings.value.replace('/api/employees', '');
      const syncUrl = `${serverUrl}/api/attendanceEdit`; // Correct endpoint

      // Build query parameters
      const params = new URLSearchParams();
      if (this.lastSyncTimestamp) {
        params.append('since', this.lastSyncTimestamp);
      }
      params.append('limit', '1000'); // Get up to 1000 records per sync

      if (!silent) {
        console.log(`Fetching from: ${syncUrl}?${params.toString()}`);
        console.log(`Since timestamp: ${this.lastSyncTimestamp || 'ALL RECORDS'}`);
      }

      const response = await fetch(`${syncUrl}?${params.toString()}`, {
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

      const responseData = result.data || result;
      const { edited = [], deleted = [] } = responseData;
      
      if (!silent) {
        console.log(`Server returned: ${edited.length} edited records, ${deleted.length} deleted records`);
      }

      if (edited.length === 0 && deleted.length === 0) {
        if (!silent) {
          console.log('✓ No server edits found (cloud database is in sync)');
        }
        return { 
          success: true, 
          checked: 0,
          updated: 0, 
          deleted: 0,
          errors: []
        };
      }

      // Apply edits to local database
      const updateResult = await this.applyServerEdits(edited, deleted);
      
      // If we successfully applied edits, mark them as synced on server
      if (updateResult.updated > 0 || updateResult.deleted > 0) {
        await this.markRecordsAsSyncedOnServer(edited, deleted);
      }
      
      // Update last sync timestamp
      this.lastSyncTimestamp = new Date().toISOString();

      if (!silent) {
        console.log(`✓ Applied ${updateResult.updated} edits and ${updateResult.deleted} deletions from server to LOCAL database`);
      }

      return {
        success: true,
        checked: edited.length + deleted.length,
        updated: updateResult.updated,
        deleted: updateResult.deleted,
        errors: updateResult.errors
      };

    } catch (error) {
      console.error('Error downloading server edits:', error);
      return {
        success: false,
        checked: 0,
        updated: 0,
        deleted: 0,
        errors: [error.message]
      };
    }
  }

  /**
   * Upload unsynced LOCAL records to server
   * This checks the LOCAL database for records to upload
   */
  async uploadUnsyncedRecords(silent = false) {
    try {
      // Get all unsynced records from LOCAL database
      const unsyncedRecords = this.db.prepare(`
        SELECT * FROM attendance 
        WHERE is_synced = 0 OR is_synced IS NULL
        ORDER BY created_at ASC
      `).all();

      if (!silent) {
        console.log(`Found ${unsyncedRecords.length} unsynced records in LOCAL database to upload`);
      }

      if (unsyncedRecords.length === 0) {
        if (!silent) {
          console.log('✓ No unsynced LOCAL records to upload');
        }
        return { success: true, uploaded: 0, errors: [] };
      }

      // Get server URL
      const settings = this.db.prepare("SELECT value FROM settings WHERE key = 'server_url' LIMIT 1").get();
      
      if (!settings || !settings.value) {
        return { success: false, uploaded: 0, errors: ['Server URL not configured'] };
      }

      const serverUrl = settings.value.replace('/api/employees', '');
      const uploadUrl = `${serverUrl}/api/attendanceEdit/batch-upload`; // Correct endpoint

      let uploaded = 0;
      const errors = [];

      // Upload in batches of 50
      const batchSize = 50;
      for (let i = 0; i < unsyncedRecords.length; i += batchSize) {
        const batch = unsyncedRecords.slice(i, i + batchSize);
        
        try {
          if (!silent) {
            console.log(`Uploading batch ${Math.floor(i/batchSize) + 1} (${batch.length} records)...`);
          }

          const response = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ records: batch }),
            timeout: 30000,
          });

          if (!response.ok) {
            throw new Error(`Server responded with ${response.status}`);
          }

          const result = await response.json();

          if (result.success) {
            // Mark records as synced in LOCAL database
            const markSyncedStmt = this.db.prepare(`
              UPDATE attendance 
              SET is_synced = 1, updated_at = datetime('now')
              WHERE id = ?
            `);

            const transaction = this.db.transaction(() => {
              for (const record of batch) {
                markSyncedStmt.run(record.id);
              }
            });

            transaction();
            uploaded += batch.length;
            
            if (!silent) {
              console.log(`✓ Uploaded batch of ${batch.length} records (${uploaded}/${unsyncedRecords.length})`);
            }
          } else {
            errors.push(`Batch upload failed: ${result.error || 'Unknown error'}`);
          }
        } catch (error) {
          errors.push(`Failed to upload batch: ${error.message}`);
          console.error(`Error uploading batch:`, error);
        }
      }

      return { success: true, uploaded, errors };

    } catch (error) {
      console.error('Error uploading unsynced records:', error);
      return { success: false, uploaded: 0, errors: [error.message] };
    }
  }

  /**
   * Apply server edits to local database
   */
  async applyServerEdits(editedRecords, deletedRecords) {
    let updated = 0;
    let deleted = 0;
    const errors = [];
    const affectedEmployeeDates = new Set();

    // Prepare statements
    const insertOrUpdateStmt = this.db.prepare(`
      INSERT INTO attendance (
        id, employee_uid, id_number, clock_type, clock_time, date,
        regular_hours, overtime_hours, is_late, notes, location,
        ip_address, device_info, is_synced, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        employee_uid = excluded.employee_uid,
        id_number = excluded.id_number,
        clock_type = excluded.clock_type,
        clock_time = excluded.clock_time,
        date = excluded.date,
        regular_hours = excluded.regular_hours,
        overtime_hours = excluded.overtime_hours,
        is_late = excluded.is_late,
        notes = excluded.notes,
        location = excluded.location,
        ip_address = excluded.ip_address,
        device_info = excluded.device_info,
        is_synced = 1,
        updated_at = excluded.updated_at
    `);

    const deleteStmt = this.db.prepare(`
      DELETE FROM attendance WHERE id = ?
    `);

    const transaction = this.db.transaction(() => {
      // Apply edits (insert or update)
      for (const record of editedRecords) {
        try {
          const result = insertOrUpdateStmt.run(
            record.id,
            record.employee_uid,
            record.id_number,
            record.clock_type,
            record.clock_time,
            record.date,
            record.regular_hours || 0,
            record.overtime_hours || 0,
            record.is_late || 0,
            record.notes || null,
            record.location || null,
            record.ip_address || null,
            record.device_info || null,
            record.created_at || new Date().toISOString(),
            record.updated_at || new Date().toISOString()
          );

          if (result.changes > 0) {
            updated++;
            console.log(`✓ Updated/Inserted attendance record ${record.id} from server`);
            affectedEmployeeDates.add(`${record.employee_uid}|${record.date}`);
          }
        } catch (error) {
          const errorMsg = `Failed to update record ${record.id}: ${error.message}`;
          errors.push(errorMsg);
          console.error(errorMsg);
        }
      }

      // Apply deletions
      for (const recordId of deletedRecords) {
        try {
          const localRecord = this.db.prepare('SELECT employee_uid, date FROM attendance WHERE id = ?').get(recordId);
          
          if (localRecord) {
            const result = deleteStmt.run(recordId);

            if (result.changes > 0) {
              deleted++;
              console.log(`✓ Deleted attendance record ${recordId} from server instruction`);
              affectedEmployeeDates.add(`${localRecord.employee_uid}|${localRecord.date}`);
            }
          }
        } catch (error) {
          const errorMsg = `Failed to delete record ${recordId}: ${error.message}`;
          errors.push(errorMsg);
          console.error(errorMsg);
        }
      }
    });

    try {
      transaction();
      
      // Rebuild daily summaries for all affected employee-dates
      if (affectedEmployeeDates.size > 0) {
        console.log(`Rebuilding daily summaries for ${affectedEmployeeDates.size} affected dates...`);
        
        for (const employeeDateKey of affectedEmployeeDates) {
          const [employeeUid, date] = employeeDateKey.split('|');
          try {
            updateDailyAttendanceSummary(employeeUid, date, this.db);
            console.log(`✓ Updated daily summary for employee ${employeeUid} on ${date}`);
          } catch (summaryError) {
            const errorMsg = `Failed to update daily summary for ${employeeUid} on ${date}: ${summaryError.message}`;
            errors.push(errorMsg);
            console.error(errorMsg);
          }
        }
      }
      
    } catch (error) {
      errors.push(`Transaction failed: ${error.message}`);
      console.error('Transaction error:', error);
    }

    return { updated, deleted, errors };
  }

  /**
   * Mark records as synced on the server after successful local update
   */
  async markRecordsAsSyncedOnServer(editedRecords, deletedRecords) {
    try {
      const settings = this.db.prepare("SELECT value FROM settings WHERE key = 'server_url' LIMIT 1").get();
      
      if (!settings || !settings.value) {
        console.warn('No server URL configured for marking synced');
        return;
      }

      const serverUrl = settings.value.replace('/api/employees', '');
      const markSyncedUrl = `${serverUrl}/api/attendanceEdit/mark-synced`;

      const editedIds = editedRecords.map(record => record.id);
      const deletedIds = deletedRecords;

      const response = await fetch(markSyncedUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          editedIds,
          deletedIds
        }),
        timeout: 30000,
      });

      if (!response.ok) {
        console.warn(`Failed to mark records as synced on server: ${response.status}`);
        return;
      }

      const result = await response.json();
      
      if (result.success) {
        console.log(`✓ Marked ${editedIds.length} edits and ${deletedIds.length} deletions as synced on server`);
      } else {
        console.warn('Server failed to mark records as synced:', result.error);
      }
    } catch (error) {
      console.warn('Error marking records as synced on server:', error.message);
    }
  }

  logSync(recordsChecked, recordsUpdated, recordsDeleted, recordsUploaded = 0, errors = []) {
    try {
      this.db.prepare(`
        INSERT INTO edit_sync_log (
          sync_timestamp, records_checked, records_updated, records_deleted, records_uploaded, errors
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        new Date().toISOString(),
        recordsChecked,
        recordsUpdated,
        recordsDeleted,
        recordsUploaded,
        errors.length > 0 ? JSON.stringify(errors) : null
      );
    } catch (error) {
      console.error('Error logging sync:', error);
    }
  }

  getSyncHistory(limit = 10) {
    try {
      return this.db.prepare(`
        SELECT * FROM edit_sync_log 
        ORDER BY id DESC 
        LIMIT ?
      `).all(limit);
    } catch (error) {
      console.error('Error getting sync history:', error);
      return [];
    }
  }

  getLastSyncInfo() {
    try {
      const lastSync = this.db.prepare(`
        SELECT * FROM edit_sync_log 
        ORDER BY id DESC 
        LIMIT 1
      `).get();

      return {
        success: true,
        lastSync: lastSync || null,
        timestamp: this.lastSyncTimestamp
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  cleanupOldLogs(daysToKeep = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const result = this.db.prepare(`
        DELETE FROM edit_sync_log 
        WHERE created_at < ?
      `).run(cutoffDate.toISOString());

      console.log(`Cleaned up ${result.changes} old sync logs`);
      return { success: true, deleted: result.changes };
    } catch (error) {
      console.error('Error cleaning up logs:', error);
      return { success: false, error: error.message };
    }
  }

  async forceSyncNow() {
    console.log('Force sync triggered by user');
    return await this.performFullSync(false);
  }
}

// Create singleton instance
const serverEditSyncService = new ServerEditSyncService();

module.exports = {
  ServerEditSyncService,
  serverEditSyncService,
  
  checkServerEdits: async (silent = false) => {
    return await serverEditSyncService.performFullSync(silent);
  },
  
  startAutoSync: () => {
    return serverEditSyncService.startAutoSync();
  },
  
  stopAutoSync: () => {
    return serverEditSyncService.stopAutoSync();
  },
  
  getSyncHistory: (limit = 10) => {
    return serverEditSyncService.getSyncHistory(limit);
  },
  
  getLastSyncInfo: () => {
    return serverEditSyncService.getLastSyncInfo();
  },
  
  initializeService: async () => {
    return await serverEditSyncService.initialize();
  },
  
  forceSyncNow: async () => {
    return await serverEditSyncService.forceSyncNow();
  }
};