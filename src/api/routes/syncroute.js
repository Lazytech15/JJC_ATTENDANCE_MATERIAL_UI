// CLIENT SIDE - Enhanced syncAttendanceData function with local server data integration
const { db } = require('../../database/setup')
const fetch = require('node-fetch')

async function syncAttendanceData() {
  try {
    console.log('Starting attendance data sync...')
    
    // Get server URL from settings
    const serverUrlQuery = `SELECT value FROM settings WHERE key = 'server_url'`
    const serverUrlResult = db.prepare(serverUrlQuery).get()
    
    if (!serverUrlResult || !serverUrlResult.value) {
      throw new Error('Server URL not configured in settings')
    }
    
    // Extract base URL
    let baseUrl = serverUrlResult.value
    const pathsToRemove = ['/api/tables/emp_list/data', '/api/tables/emp_list', '/api/tables', '/api']
    
    for (const path of pathsToRemove) {
      if (baseUrl.endsWith(path)) {
        baseUrl = baseUrl.slice(0, -path.length)
        break
      }
    }
    
    baseUrl = baseUrl.replace(/\/$/, '')
    console.log(`Target server: ${baseUrl}`)
    
    // First, fetch comprehensive data from local export server
    console.log('Fetching comprehensive data from local export server...')
    let localServerData = null
    try {
      const localResponse = await fetch('http://localhost:3001/employees?includeAttendance=true&includeProfiles=true', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'AttendanceSystem/1.0'
        },
        timeout: 30000
      })
      
      if (localResponse.ok) {
        const localData = await localResponse.json()
        if (localData.success && localData.data) {
          localServerData = localData.data
          console.log(`Fetched data for ${localServerData.length} employees from local server`)
        }
      } else {
        console.warn('Could not fetch from local export server:', localResponse.status, localResponse.statusText)
      }
    } catch (localError) {
      console.warn('Failed to fetch from local export server:', localError.message)
    }
    
    // Get unsynced attendance records from database (fallback method)
    const attendanceQuery = `
      SELECT 
        a.id,
        a.employee_uid,
        a.id_number,
        a.clock_type,
        a.clock_time,
        a.regular_hours,
        a.overtime_hours,
        a.date,
        a.is_synced,
        a.created_at,
        a.is_late,
        a.notes,
        a.location,
        a.ip_address,
        a.device_info,
        e.first_name,
        e.middle_name,
        e.last_name,
        e.email,
        e.department,
        e.status,
        e.profile_picture,
        e.position
      FROM attendance a
      LEFT JOIN employees e ON a.employee_uid = e.uid
      WHERE a.is_synced = 0 OR a.is_synced IS NULL
      ORDER BY a.created_at ASC
    `
    
    const attendanceRecords = db.prepare(attendanceQuery).all()
    console.log(`Found ${attendanceRecords.length} unsynced attendance records`)
    
    // Prepare comprehensive payload
    const payload = {
      timestamp: new Date().toISOString(),
      source: 'client-sync-enhanced',
      syncType: 'comprehensive',
      localServerAvailable: !!localServerData,
      totalUnsynced: attendanceRecords.length,
      
      // Include comprehensive employee data from local server if available
      employeesWithAttendance: localServerData || [],
      
      // Include unsynced records for fallback processing
      unsyncedRecords: attendanceRecords.map(record => ({
        // Attendance data
        id: record.id,
        employee_uid: record.employee_uid,
        id_number: record.id_number,
        clock_type: record.clock_type,
        clock_time: record.clock_time,
        regular_hours: record.regular_hours || 0,
        overtime_hours: record.overtime_hours || 0,
        date: record.date,
        is_late: record.is_late || 0,
        notes: record.notes,
        location: record.location,
        ip_address: record.ip_address,
        device_info: record.device_info,
        created_at: record.created_at,
        // Employee data
        employee_info: {
          uid: record.employee_uid,
          first_name: record.first_name,
          middle_name: record.middle_name,
          last_name: record.last_name,
          email: record.email,
          department: record.department,
          position: record.position,
          status: record.status,
          profile_picture: record.profile_picture
        }
      })),
      
      // Additional metadata
      metadata: {
        totalEmployees: localServerData ? localServerData.length : 0,
        syncMethod: localServerData ? 'comprehensive' : 'unsynced-only',
        hasProfileData: localServerData ? localServerData.some(emp => emp.hasProfileImage) : false,
        dateRange: localServerData ? {
          employeesWithAttendance: localServerData.filter(emp => emp.attendanceRecords && emp.attendanceRecords.length > 0).length,
          totalAttendanceRecords: localServerData.reduce((total, emp) => total + (emp.attendanceRecords ? emp.attendanceRecords.length : 0), 0)
        } : null
      }
    }
    
    // If no local server data and no unsynced records, nothing to sync
    if (!localServerData && attendanceRecords.length === 0) {
      return {
        success: true,
        message: 'No attendance records to sync',
        syncedCount: 0,
        totalRecords: 0,
        method: 'no-data'
      }
    }
    
    const targetUrl = `${baseUrl}/api/attendance/sync/comprehensive`
    console.log(`Sending comprehensive data to ${targetUrl}`)
    console.log(`Payload includes: ${payload.employeesWithAttendance.length} employees, ${payload.unsyncedRecords.length} unsynced records`)
    
    // Send data to server
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'AttendanceSystem/1.0',
        'X-Sync-Source': 'client-enhanced',
        'X-Sync-Type': 'comprehensive'
      },
      body: JSON.stringify(payload),
      timeout: 120000 // 2 minute timeout for large comprehensive data
    })
    
    if (!response.ok) {
      // If comprehensive endpoint fails, try the original endpoint with just unsynced records
      console.log('Comprehensive sync failed, falling back to original sync method...')
      
      if (attendanceRecords.length === 0) {
        throw new Error(`Comprehensive sync failed and no unsynced records available. Server responded with: ${response.status} ${response.statusText}`)
      }
      
      const fallbackPayload = {
        timestamp: new Date().toISOString(),
        source: 'client-sync-fallback',
        totalRecords: attendanceRecords.length,
        records: payload.unsyncedRecords
      }
      
      const fallbackUrl = `${baseUrl}/api/attendance/sync`
      console.log(`Falling back to ${fallbackUrl} with ${fallbackPayload.records.length} records`)
      
      const fallbackResponse = await fetch(fallbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'AttendanceSystem/1.0',
          'X-Sync-Source': 'client-fallback'
        },
        body: JSON.stringify(fallbackPayload),
        timeout: 60000
      })
      
      if (!fallbackResponse.ok) {
        const errorText = await fallbackResponse.text()
        throw new Error(`Both comprehensive and fallback sync failed. Last error: ${fallbackResponse.status} ${fallbackResponse.statusText}. Response: ${errorText}`)
      }
      
      const fallbackResult = await fallbackResponse.json()
      console.log('Fallback sync response:', fallbackResult)
      
      // Mark only unsynced records as synced
      if (fallbackResult.success && attendanceRecords.length > 0) {
        const recordIds = attendanceRecords.map(r => r.id)
        const placeholders = recordIds.map(() => '?').join(',')
        const updateSyncQuery = `UPDATE attendance SET is_synced = 1, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`
        
        const updateResult = db.prepare(updateSyncQuery).run(...recordIds)
        
        return {
          success: true,
          message: 'Attendance data synced successfully (fallback method)',
          syncedCount: updateResult.changes,
          totalRecords: attendanceRecords.length,
          method: 'fallback',
          serverResponse: fallbackResult,
          targetUrl: fallbackUrl
        }
      }
      
      throw new Error(fallbackResult.message || 'Fallback sync returned failure status')
    }
    
    const result = await response.json()
    console.log('Comprehensive sync response:', result)
    
    // Mark unsynced records as synced if successful
    if (result.success && attendanceRecords.length > 0) {
      const recordIds = attendanceRecords.map(r => r.id)
      const placeholders = recordIds.map(() => '?').join(',')
      const updateSyncQuery = `UPDATE attendance SET is_synced = 1, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`
      
      const updateResult = db.prepare(updateSyncQuery).run(...recordIds)
      
      console.log(`Marked ${updateResult.changes} records as synced`)
      
      return {
        success: true,
        message: 'Comprehensive attendance data synced successfully',
        syncedCount: updateResult.changes,
        totalRecords: attendanceRecords.length,
        totalEmployees: payload.employeesWithAttendance.length,
        method: 'comprehensive',
        serverResponse: result,
        targetUrl: targetUrl,
        comprehensiveData: {
          employeesIncluded: payload.employeesWithAttendance.length,
          totalAttendanceRecords: payload.metadata.dateRange?.totalAttendanceRecords || 0,
          hasProfileData: payload.metadata.hasProfileData
        }
      }
    } else {
      throw new Error(result.message || 'Server returned failure status')
    }
    
  } catch (error) {
    console.error('Error syncing attendance data:', error)
    return {
      success: false,
      error: error.message,
      syncedCount: 0,
      totalRecords: 0,
      method: 'error'
    }
  }
}

module.exports = { syncAttendanceData }