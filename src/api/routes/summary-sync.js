
const { getDatabase, updateDailyAttendanceSummary } = require("../../database/setup")
const fetch = require('node-fetch')

async function syncDailySummaryToServer(ignoreTransactionErrors = false) {
  const db = getDatabase()
  
  try {
    // Get server URL from settings
    const settingsStmt = db.prepare("SELECT value FROM settings WHERE key = 'server_url'")
    const serverUrlRow = settingsStmt.get()
    
    if (!serverUrlRow || !serverUrlRow.value) {
      throw new Error('Server URL not configured in settings')
    }
    
    // Extract base URL and create daily summary endpoint
    const fullUrl = serverUrlRow.value
    const baseUrl = fullUrl.replace('/api/tables/emp_list/data', '')
    const syncEndpoint = `${baseUrl}/api/dailysummary`
    
    console.log('Syncing daily summary to:', syncEndpoint)
    
    // FIRST: Update daily summaries for recent attendance data
    await updateRecentDailySummaries(db)
    
    // Get ALL daily summary records (removed the last sync condition)
    const summaryStmt = db.prepare(`
      SELECT 
        id,
        employee_uid,
        id_number,
        id_barcode,
        employee_name,
        first_name,
        last_name,
        department,
        date,
        first_clock_in,
        last_clock_out,
        morning_in,
        morning_out,
        afternoon_in,
        afternoon_out,
        evening_in,
        evening_out,
        overtime_in,
        overtime_out,
        regular_hours,
        overtime_hours,
        total_hours,
        morning_hours,
        afternoon_hours,
        evening_hours,
        overtime_session_hours,
        is_incomplete,
        has_late_entry,
        has_overtime,
        has_evening_session,
        total_sessions,
        completed_sessions,
        pending_sessions,
        total_minutes_worked,
        break_time_minutes,
        last_updated,
        created_at
      FROM daily_attendance_summary 
      ORDER BY last_updated ASC
    `)
    
    const allRecords = summaryStmt.all()
    
    if (allRecords.length === 0) {
      return {
        success: true,
        message: 'No daily summary records found',
        syncedCount: 0
      }
    }
    
    console.log(`Syncing ${allRecords.length} daily summary records (ALL records)`)
    
    // Send data to server
    const response = await fetch(syncEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        daily_summary_data: allRecords
      })
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      
      // Check if this is the transaction rollback error we want to ignore
      if (ignoreTransactionErrors && errorText.includes('cannot rollback - no transaction is active')) {
        console.warn('Ignoring transaction rollback error as requested:', errorText)
        
        // Still update the sync timestamp since data was likely processed
        const currentTimestamp = new Date().toISOString()
        const updateSyncTimestamp = db.prepare(`
          INSERT OR REPLACE INTO settings (key, value, updated_at) 
          VALUES ('last_daily_summary_sync', ?, ?)
        `)
        
        updateSyncTimestamp.run(currentTimestamp, currentTimestamp)
        
        return {
          success: true,
          message: `Sync completed with ignored transaction error. Synced ${allRecords.length} records.`,
          syncedCount: allRecords.length,
          warning: 'Transaction rollback error was ignored',
          serverResponse: { error: errorText }
        }
      }
      
      throw new Error(`Server responded with status ${response.status}: ${errorText}`)
    }
    
    const result = await response.json()
    console.log('Server response:', result)
    
    // Update last sync timestamp
    const currentTimestamp = new Date().toISOString()
    const updateSyncTimestamp = db.prepare(`
      INSERT OR REPLACE INTO settings (key, value, updated_at) 
      VALUES ('last_daily_summary_sync', ?, ?)
    `)
    
    updateSyncTimestamp.run(currentTimestamp, currentTimestamp)
    
    return {
      success: true,
      message: `Successfully synced ${allRecords.length} daily summary records (ALL records)`,
      syncedCount: allRecords.length,
      serverResponse: result
    }
    
  } catch (error) {
    console.error('Error syncing daily summary:', error)
    return {
      success: false,
      message: `Failed to sync daily summary: ${error.message}`,
      syncedCount: 0
    }
  }
}

// Function to update daily summaries for recent attendance changes
async function updateRecentDailySummaries(db) {
  try {
    console.log('Updating daily summaries for recent attendance changes...')
    
    // Get the last daily summary sync time
    const lastSyncStmt = db.prepare("SELECT value FROM settings WHERE key = 'last_daily_summary_sync'")
    const lastSyncRow = lastSyncStmt.get()
    const lastSyncTime = lastSyncRow ? lastSyncRow.value : '1970-01-01T00:00:00.000Z'
    
    console.log('Last daily summary sync time:', lastSyncTime)
    
    // Find all unique employee-date combinations that have been updated since last sync
    const recentAttendanceStmt = db.prepare(`
      SELECT DISTINCT employee_uid, date
      FROM attendance 
      WHERE created_at > ? OR clock_time > ?
      ORDER BY date DESC, employee_uid
    `)
    
    const recentChanges = recentAttendanceStmt.all(lastSyncTime, lastSyncTime)
    
    console.log(`Found ${recentChanges.length} employee-date combinations with recent changes`)
    
    // Also check for any dates in the last 7 days to ensure we catch everything
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
    const recentDatesStmt = db.prepare(`
      SELECT DISTINCT employee_uid, date
      FROM attendance 
      WHERE date >= ?
      ORDER BY date DESC, employee_uid
    `)
    
    const recentDatesChanges = recentDatesStmt.all(sevenDaysAgo.toISOString().split('T')[0])
    
    // Combine and deduplicate the changes
    const allChanges = new Map()
    
    recentChanges.forEach(change => {
      const key = `${change.employee_uid}-${change.date}`
      allChanges.set(key, change)
    })
    
    recentDatesChanges.forEach(change => {
      const key = `${change.employee_uid}-${change.date}`
      allChanges.set(key, change)
    })
    
    const uniqueChanges = Array.from(allChanges.values())
    console.log(`Processing ${uniqueChanges.length} unique employee-date combinations`)
    
    // Update daily summaries for each combination
    let updateCount = 0
    let errorCount = 0
    
    for (const { employee_uid, date } of uniqueChanges) {
      try {
        const success = updateDailyAttendanceSummary(employee_uid, date, db)
        if (success) {
          updateCount++
          // console.log(`✓ Updated daily summary for employee ${employee_uid} on ${date}`)
        } else {
          errorCount++
          console.log(`✗ Failed to update daily summary for employee ${employee_uid} on ${date}`)
        }
      } catch (error) {
        errorCount++
        console.error(`Error updating daily summary for employee ${employee_uid} on ${date}:`, error)
      }
    }
    
    console.log(`Daily summary update completed: ${updateCount} successful, ${errorCount} failed`)
    
    return { updateCount, errorCount, totalProcessed: uniqueChanges.length }
    
  } catch (error) {
    console.error('Error updating recent daily summaries:', error)
    return { updateCount: 0, errorCount: 0, totalProcessed: 0 }
  }
}

// Function to trigger daily summary update after attendance sync
async function syncAttendanceAndUpdateSummary() {
  const db = getDatabase()
  
  try {
    // First sync attendance (your existing attendance sync code)
    console.log('Syncing attendance data...')
    // ... your attendance sync code here ...
    
    // After attendance sync, update daily summaries
    console.log('Updating daily summaries after attendance sync...')
    const updateResult = await updateRecentDailySummaries(db)
    
    // Then sync daily summaries to server
    console.log('Syncing daily summaries to server...')
    const syncResult = await syncDailySummaryToServer()
    
    return {
      success: true,
      attendanceSync: true, // Replace with actual attendance sync result
      dailySummaryUpdate: updateResult,
      dailySummarySync: syncResult
    }
    
  } catch (error) {
    console.error('Error in combined sync process:', error)
    return {
      success: false,
      error: error.message
    }
  }
}

// Modified debug function - now shows ALL records will be synced
async function debugDailySummaryStatus() {
  const db = getDatabase()
  
  try {
    // Check total daily summary records
    const totalStmt = db.prepare('SELECT COUNT(*) as total FROM daily_attendance_summary')
    const totalResult = totalStmt.get()
    
    // Check recent daily summary records
    const recentStmt = db.prepare(`
      SELECT COUNT(*) as recent 
      FROM daily_attendance_summary 
      WHERE last_updated > datetime('now', '-7 days')
    `)
    const recentResult = recentStmt.get()
    
    // Get last sync time (for reference only)
    const lastSyncStmt = db.prepare("SELECT value FROM settings WHERE key = 'last_daily_summary_sync'")
    const lastSyncRow = lastSyncStmt.get()
    const lastSyncTime = lastSyncRow ? lastSyncRow.value : null
    
    // Get some sample records that will be synced (ALL records now)
    const sampleStmt = db.prepare(`
      SELECT 
        employee_uid,
        employee_name,
        date,
        last_updated,
        created_at,
        total_hours
      FROM daily_attendance_summary 
      ORDER BY last_updated DESC 
      LIMIT 10
    `)
    const sampleRecords = sampleStmt.all()
    
    // Check for recent attendance without daily summary
    const attendanceWithoutSummaryStmt = db.prepare(`
      SELECT COUNT(*) as missing
      FROM (
        SELECT DISTINCT employee_uid, date
        FROM attendance 
        WHERE date >= date('now', '-7 days')
      ) a
      LEFT JOIN daily_attendance_summary s ON a.employee_uid = s.employee_uid AND a.date = s.date
      WHERE s.id IS NULL
    `)
    const missingResult = attendanceWithoutSummaryStmt.get()
    
    return {
      totalDailySummaryRecords: totalResult.total,
      recentDailySummaryRecords: recentResult.recent,
      recordsToSyncNext: totalResult.total, // ALL records will be synced now
      lastSyncTime: lastSyncTime,
      currentTime: new Date().toISOString(),
      attendanceRecordsMissingSummary: missingResult.missing,
      sampleRecords: sampleRecords,
      note: "ALL daily summary records will be synced on next sync call"
    }
    
  } catch (error) {
    console.error('Error in debug status:', error)
    return { error: error.message }
  }
}

// Modified function - now returns count of ALL records since we sync everything
async function getUnsyncedDailySummaryCount() {
  const db = getDatabase()
  
  try {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM daily_attendance_summary')
    const result = stmt.get()
    
    return {
      success: true,
      count: result.count,
      note: "This count represents ALL records since we now sync everything each time"
    }
  } catch (error) {
    console.error('Error getting daily summary count:', error)
    return {
      success: false,
      count: 0,
      error: error.message
    }
  }
}

async function getAllDailySummaryForSync(limit = 1000) {
  const db = getDatabase()
  
  try {
    const stmt = db.prepare(`
      SELECT 
        s.*,
        e.email,
        e.position,
        e.hire_date,
        e.status as employee_status
      FROM daily_attendance_summary s
      LEFT JOIN employees e ON s.employee_uid = e.uid
      ORDER BY s.last_updated DESC
      LIMIT ?
    `)
    
    const records = stmt.all(limit)
    
    return {
      success: true,
      data: records,
      total: records.length
    }
  } catch (error) {
    console.error('Error getting daily summary data:', error)
    return {
      success: false,
      data: [],
      total: 0,
      error: error.message
    }
  }
}

async function forceSyncAllDailySummary(ignoreTransactionErrors = false) {
  const db = getDatabase()
  
  try {
    // First, ensure all daily summaries are up to date
    console.log('Rebuilding all daily summaries before sync...')
    
    // Get all unique employee-date combinations from attendance
    const allAttendanceStmt = db.prepare(`
      SELECT DISTINCT employee_uid, date
      FROM attendance 
      ORDER BY date DESC, employee_uid
    `)
    
    const allCombinations = allAttendanceStmt.all()
    console.log(`Found ${allCombinations.length} employee-date combinations to rebuild`)
    
    // Update daily summaries for all combinations
    let rebuildCount = 0
    for (const { employee_uid, date } of allCombinations) {
      try {
        const success = updateDailyAttendanceSummary(employee_uid, date, db)
        if (success) rebuildCount++
      } catch (error) {
        console.error(`Error rebuilding summary for employee ${employee_uid} on ${date}:`, error)
      }
    }
    
    console.log(`Rebuilt ${rebuildCount} daily summaries`)
    
    // Now perform the sync with error ignore option
    const result = await syncDailySummaryToServer(ignoreTransactionErrors)
    
    return {
      success: result.success,
      message: `Force sync completed: ${result.message} (Rebuilt ${rebuildCount} summaries)`,
      syncedCount: result.syncedCount,
      rebuiltCount: rebuildCount,
      serverResponse: result.serverResponse,
      warning: result.warning
    }
    
  } catch (error) {
    console.error('Error in force sync:', error)
    return {
      success: false,
      message: `Force sync failed: ${error.message}`,
      syncedCount: 0
    }
  }
}

async function getDailySummaryLastSyncTime() {
  const db = getDatabase()
  
  try {
    const stmt = db.prepare("SELECT value FROM settings WHERE key = 'last_daily_summary_sync'")
    const result = stmt.get()
    
    return {
      success: true,
      lastSync: result ? result.value : null,
      note: "This timestamp is for reference only - ALL records are synced each time now"
    }
  } catch (error) {
    console.error('Error getting last sync time:', error)
    return {
      success: false,
      lastSync: null,
      error: error.message
    }
  }
}

module.exports = {
  syncDailySummaryToServer,
  getUnsyncedDailySummaryCount,
  getAllDailySummaryForSync,
  forceSyncAllDailySummary,
  getDailySummaryLastSyncTime,
  // Exports
  updateRecentDailySummaries,
  syncAttendanceAndUpdateSummary,
  debugDailySummaryStatus
}