const { getDatabase } = require("../../database/setup")
const fetch = require('node-fetch')
// Import the daily summary sync functions
const { syncDailySummaryToServer } = require('./summary-sync')


async function syncAttendanceToServer() {
  const db = getDatabase()
  
  try {
    // Get server URL from settings
    const settingsStmt = db.prepare("SELECT value FROM settings WHERE key = 'server_url'")
    const serverUrlRow = settingsStmt.get()
    
    if (!serverUrlRow || !serverUrlRow.value) {
      throw new Error('Server URL not configured in settings')
    }
    
    // Extract base URL by removing the endpoint part
    const fullUrl = serverUrlRow.value
    const baseUrl = fullUrl.replace('/api/tables/emp_list/data', '')
    const syncEndpoint = `${baseUrl}/api/attendance`
    
    console.log('Syncing attendance to:', syncEndpoint)
    
    // Get all unsynced attendance records
    const attendanceStmt = db.prepare(`
      SELECT 
        id,
        employee_uid,
        id_number,
        clock_type,
        clock_time,
        regular_hours,
        overtime_hours,
        date,
        is_late,
        created_at
      FROM attendance 
      WHERE is_synced = 0
      ORDER BY created_at ASC
    `)
    
    const unsyncedRecords = attendanceStmt.all()
    
    if (unsyncedRecords.length === 0) {
      // Even if no attendance records to sync, try to sync daily summary
      console.log('No attendance records to sync, checking daily summary...')
      
      try {
        const summaryResult = await syncDailySummaryToServer()
        return {
          success: true,
          message: `No attendance records to sync. Daily summary sync: ${summaryResult.message}`,
          syncedCount: 0,
          summarySyncResult: summaryResult
        }
      } catch (summaryError) {
        console.error('Error syncing daily summary:', summaryError)
        return {
          success: true,
          message: 'No attendance records to sync, but daily summary sync failed',
          syncedCount: 0,
          summaryError: summaryError.message
        }
      }
    }
    
    console.log(`Found ${unsyncedRecords.length} unsynced attendance records`)
    
    // Send attendance data to server
    const response = await fetch(syncEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        attendance_data: unsyncedRecords
      })
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Server responded with status ${response.status}: ${errorText}`)
    }
    
    const result = await response.json()
    console.log('Attendance sync server response:', result)
    
    // Mark attendance records as synced
    const updateStmt = db.prepare("UPDATE attendance SET is_synced = 1 WHERE id = ?")
    
    const updateTransaction = db.transaction((records) => {
      for (const record of records) {
        updateStmt.run(record.id)
      }
    })
    
    updateTransaction(unsyncedRecords)
    
    // After successful attendance sync, also sync daily summary
    let summaryResult = null
    try {
      console.log('Syncing daily summary after attendance sync...')
      summaryResult = await syncDailySummaryToServer()
      console.log('Daily summary sync completed:', summaryResult.message)
    } catch (summaryError) {
      console.error('Error syncing daily summary after attendance sync:', summaryError)
      summaryResult = {
        success: false,
        message: `Daily summary sync failed: ${summaryError.message}`,
        syncedCount: 0
      }
    }
    
    return {
      success: true,
      message: `Successfully synced ${unsyncedRecords.length} attendance records. ${summaryResult ? summaryResult.message : 'Daily summary sync skipped.'}`,
      syncedCount: unsyncedRecords.length,
      serverResponse: result,
      summarySyncResult: summaryResult
    }
    
  } catch (error) {
    console.error('Error syncing attendance:', error)
    
    // Even if attendance sync fails, try to sync daily summary
    let summaryResult = null
    try {
      console.log('Attempting daily summary sync despite attendance sync failure...')
      summaryResult = await syncDailySummaryToServer()
    } catch (summaryError) {
      console.error('Daily summary sync also failed:', summaryError)
      summaryResult = {
        success: false,
        message: `Daily summary sync failed: ${summaryError.message}`,
        syncedCount: 0
      }
    }
    
    return {
      success: false,
      message: `Failed to sync attendance: ${error.message}. ${summaryResult ? summaryResult.message : ''}`,
      syncedCount: 0,
      summarySyncResult: summaryResult
    }
  }
}

async function getUnsyncedAttendanceCount() {
  const db = getDatabase()
  
  try {
    const stmt = db.prepare("SELECT COUNT(*) as count FROM attendance WHERE is_synced = 0")
    const result = stmt.get()
    
    return {
      success: true,
      count: result.count
    }
  } catch (error) {
    console.error('Error getting unsynced count:', error)
    return {
      success: false,
      count: 0,
      error: error.message
    }
  }
}

async function getAllAttendanceForSync() {
  const db = getDatabase()
  
  try {
    const stmt = db.prepare(`
      SELECT 
        a.*,
        e.name as employee_name,
        e.department
      FROM attendance a
      LEFT JOIN employees e ON a.employee_uid = e.uid
      ORDER BY a.created_at DESC
      LIMIT 1000
    `)
    
    const records = stmt.all()
    
    return {
      success: true,
      data: records,
      total: records.length
    }
  } catch (error) {
    console.error('Error getting attendance data:', error)
    return {
      success: false,
      data: [],
      total: 0,
      error: error.message
    }
  }
}

async function markAttendanceAsSynced(attendanceIds) {
  const db = getDatabase()
  
  try {
    const updateStmt = db.prepare("UPDATE attendance SET is_synced = 1 WHERE id = ?")
    
    const updateTransaction = db.transaction((ids) => {
      for (const id of ids) {
        updateStmt.run(id)
      }
    })
    
    updateTransaction(attendanceIds)
    
    return {
      success: true,
      message: `Marked ${attendanceIds.length} records as synced`,
      updatedCount: attendanceIds.length
    }
  } catch (error) {
    console.error('Error marking records as synced:', error)
    return {
      success: false,
      message: `Failed to mark records as synced: ${error.message}`,
      updatedCount: 0
    }
  }
}

// New function to sync both attendance and daily summary in one call
async function syncAllDataToServer() {
  console.log('Starting comprehensive sync of all data...')
  
  try {
    // First sync attendance
    const attendanceResult = await syncAttendanceToServer()
    
    return {
      success: attendanceResult.success,
      message: `Comprehensive sync completed. ${attendanceResult.message}`,
      attendanceSync: {
        success: attendanceResult.success,
        syncedCount: attendanceResult.syncedCount,
        message: attendanceResult.message
      },
      summarySync: attendanceResult.summarySyncResult || { success: false, message: 'Not attempted' }
    }
    
  } catch (error) {
    console.error('Error in comprehensive sync:', error)
    return {
      success: false,
      message: `Comprehensive sync failed: ${error.message}`,
      attendanceSync: { success: false, syncedCount: 0 },
      summarySync: { success: false, syncedCount: 0 }
    }
  }
}

module.exports = {
  syncAttendanceToServer,
  getUnsyncedAttendanceCount,
  getAllAttendanceForSync,
  markAttendanceAsSynced,
  syncAllDataToServer // Export the new comprehensive sync function
}