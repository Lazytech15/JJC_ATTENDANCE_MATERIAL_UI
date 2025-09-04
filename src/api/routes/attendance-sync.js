const { getDatabase } = require("../../database/setup")
const fetch = require('node-fetch')

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
      return {
        success: true,
        message: 'No records to sync',
        syncedCount: 0
      }
    }
    
    console.log(`Found ${unsyncedRecords.length} unsynced attendance records`)
    
    // Send data to server
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
    console.log('Server response:', result)
    
    // Mark records as synced
    const updateStmt = db.prepare("UPDATE attendance SET is_synced = 1 WHERE id = ?")
    
    const updateTransaction = db.transaction((records) => {
      for (const record of records) {
        updateStmt.run(record.id)
      }
    })
    
    updateTransaction(unsyncedRecords)
    
    return {
      success: true,
      message: `Successfully synced ${unsyncedRecords.length} attendance records`,
      syncedCount: unsyncedRecords.length,
      serverResponse: result
    }
    
  } catch (error) {
    console.error('Error syncing attendance:', error)
    return {
      success: false,
      message: `Failed to sync attendance: ${error.message}`,
      syncedCount: 0
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

module.exports = {
  syncAttendanceToServer,
  getUnsyncedAttendanceCount,
  getAllAttendanceForSync,
  markAttendanceAsSynced
}