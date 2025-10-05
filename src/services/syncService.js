const fetch = require("node-fetch")
const Employee = require("../database/models/employee")
const ProfileService = require("./profileService")
const { getDatabase } = require("../database/setup")
const { validateAndCorrectUnsyncedRecords, validateAttendanceData } = require("../services/validateTime")

class SyncService {
  static async syncEmployees() {
    try {
      const db = getDatabase()
      const settingsStmt = db.prepare("SELECT value FROM settings WHERE key = ?")
      const serverUrl = settingsStmt.get("server_url")?.value

      if (!serverUrl) {
        throw new Error("Server URL not configured")
      }

      console.log("Syncing employees from:", serverUrl)

      // Create AbortController for proper timeout handling
      const controller = new AbortController()
      const timeoutId = setTimeout(() => {
        controller.abort()
      }, 30000) // 30 seconds timeout

      let response
      try {
        response = await fetch(serverUrl, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "AttendanceApp/1.0"
          },
          signal: controller.signal
        })

        // Clear timeout if request succeeds
        clearTimeout(timeoutId)
      } catch (fetchError) {
        clearTimeout(timeoutId)

        if (fetchError.name === 'AbortError') {
          throw new Error("Request timed out after 30 seconds. Please check your network connection and server status.")
        }

        // Handle other network errors
        if (fetchError.code === 'ENOTFOUND') {
          throw new Error("Cannot reach server. Please check the server URL and your network connection.")
        } else if (fetchError.code === 'ECONNREFUSED') {
          throw new Error("Connection refused. Please check if the server is running.")
        } else if (fetchError.code === 'ETIMEDOUT') {
          throw new Error("Connection timed out. Please check your network connection.")
        }

        throw fetchError
      }

      if (!response.ok) {
        throw new Error(`Server responded with status ${response.status}: ${response.statusText}`)
      }

      console.log("Parsing response data...")
      const data = await response.json()

      // Extract employee data from response
      let employees = []
      if (Array.isArray(data)) {
        employees = data
      } else if (data.employees && Array.isArray(data.employees)) {  // ← Add this check
        employees = data.employees
      } else if (data.data && Array.isArray(data.data)) {
        employees = data.data
      } else {
        throw new Error("Invalid response format")
      }

      console.log(`Received ${employees.length} employee records`)

      // Filter and map employee data
      const mappedEmployees = employees
        .map((emp) => ({
          uid: emp.id,  // ← API uses 'id', not 'uid'
          id_number: emp.idNumber,  // ← camelCase in API
          id_barcode: emp.idBarcode,  // ← camelCase in API
          first_name: emp.firstName,  // ← camelCase in API
          middle_name: emp.middleName,  // ← camelCase in API
          last_name: emp.lastName,  // ← camelCase in API
          email: emp.email,
          department: emp.department,
          status: emp.status || "Active",
          profile_picture: emp.profilePicture,  // ← camelCase in API
        }))
        .filter((emp) => emp.uid && emp.first_name && emp.last_name)

      if (mappedEmployees.length === 0) {
        throw new Error("No valid employee data found")
      }

      console.log(`Processing ${mappedEmployees.length} valid employee records`)

      // Insert employees into database
      Employee.insertMany(mappedEmployees)

      // Update last sync timestamp
      const updateStmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      updateStmt.run("last_sync", Date.now().toString())

      // Start profile sync in background using bulk download
      this.syncProfileImagesBulk(mappedEmployees).catch(error => {
        console.error("Profile sync background error:", error)
      })

      console.log(`Successfully synced ${mappedEmployees.length} employees`)

      return {
        success: true,
        count: mappedEmployees.length,
        message: `Synced ${mappedEmployees.length} employees successfully`,
      }
    } catch (error) {
      console.error("Sync error:", error)
      return {
        success: false,
        error: error.message,
      }
    }
  }

  /**
   * NEW: Sync attendance data to server with validation
   * This validates data before sending and handles sync status properly
   */
  static async syncAttendanceData(options = {}) {
    const {
      validateBeforeSync = true,
      dateRange = null,
      employeeUid = null,
      batchSize = 100,
      maxRetries = 3
    } = options

    try {
      const db = getDatabase()
      const settingsStmt = db.prepare("SELECT value FROM settings WHERE key = ?")
      const serverUrl = settingsStmt.get("server_url")?.value

      if (!serverUrl) {
        throw new Error("Server URL not configured")
      }

      // Extract base URL and construct attendance sync endpoint
      const baseUrl = serverUrl.split("/api")[0]
      const syncEndpoint = `${baseUrl}/api/attendance/sync`

      console.log(`=== STARTING ATTENDANCE DATA SYNC ===`)
      console.log(`Sync endpoint: ${syncEndpoint}`)
      console.log(`Validate before sync: ${validateBeforeSync}`)

      let validationResult = null

      // Step 1: Validate data before sync if requested
      if (validateBeforeSync) {
        console.log(`Step 1: Validating attendance data...`)

        if (dateRange) {
          validationResult = await validateAttendanceData(
            dateRange.startDate,
            dateRange.endDate,
            employeeUid,
            {
              autoCorrect: true,
              updateSyncStatus: true, // This will set corrected records to is_synced = 0
              validateStatistics: true,
              rebuildSummary: true
            }
          )
        } else {
          // Validate only unsynced records if no date range specified
          validationResult = await validateAndCorrectUnsyncedRecords({
            autoCorrect: true,
            updateSyncStatus: true,
            validateStatistics: true,
            rebuildSummary: true
          })
        }

        console.log(`Validation completed:`)
        console.log(`- Total records: ${validationResult.totalRecords}`)
        console.log(`- Valid records: ${validationResult.validRecords}`)
        console.log(`- Corrected records: ${validationResult.correctedRecords}`)
        console.log(`- Error records: ${validationResult.errorRecords}`)

        if (validationResult.correctedRecords > 0) {
          console.log(`⚠️  ${validationResult.correctedRecords} records were corrected and marked for sync`)
        }
      }

      // Step 2: Get unsynced attendance records
      console.log(`Step 2: Retrieving unsynced attendance records...`)

      let unsyncedQuery = `
        SELECT 
          a.id,
          a.employee_uid,
          a.id_number,
          a.scanned_barcode,
          a.clock_type,
          a.clock_time,
          a.regular_hours,
          a.overtime_hours,
          a.date,
          a.is_late,
          a.created_at,
          e.first_name,
          e.last_name,
          e.department,
          e.id_barcode
        FROM attendance a
        JOIN employees e ON a.employee_uid = e.uid
        WHERE a.is_synced = 0
      `
      const params = []

      if (dateRange) {
        unsyncedQuery += ` AND a.date BETWEEN ? AND ?`
        params.push(dateRange.startDate, dateRange.endDate)
      }

      if (employeeUid) {
        unsyncedQuery += ` AND a.employee_uid = ?`
        params.push(employeeUid)
      }

      unsyncedQuery += ` ORDER BY a.employee_uid, a.date, a.clock_time`

      const unsyncedRecords = db.prepare(unsyncedQuery).all(...params)

      if (unsyncedRecords.length === 0) {
        console.log(`No unsynced attendance records found`)
        return {
          success: true,
          message: "No unsynced records to sync",
          syncedRecords: 0,
          validationResult: validationResult
        }
      }

      console.log(`Found ${unsyncedRecords.length} unsynced attendance records`)

      // Step 3: Process records in batches
      console.log(`Step 3: Syncing records in batches of ${batchSize}...`)

      let totalSynced = 0
      let totalErrors = 0
      const syncResults = []

      for (let i = 0; i < unsyncedRecords.length; i += batchSize) {
        const batch = unsyncedRecords.slice(i, i + batchSize)
        const batchNumber = Math.floor(i / batchSize) + 1
        const totalBatches = Math.ceil(unsyncedRecords.length / batchSize)

        console.log(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} records)...`)

        const batchResult = await this.syncAttendanceBatch(batch, syncEndpoint, maxRetries)

        syncResults.push(batchResult)
        totalSynced += batchResult.successCount
        totalErrors += batchResult.errorCount

        if (batchResult.successCount > 0) {
          // Mark successful records as synced
          await this.markRecordsAsSynced(batchResult.successfulIds, db)
        }

        // Small delay between batches to avoid overwhelming server
        if (i + batchSize < unsyncedRecords.length) {
          await new Promise(resolve => setTimeout(resolve, 500))
        }
      }

      // Step 4: Summary and final validation
      console.log(`Step 4: Sync summary...`)
      console.log(`Total synced: ${totalSynced}/${unsyncedRecords.length}`)
      console.log(`Total errors: ${totalErrors}`)

      const finalResult = {
        success: totalSynced > 0,
        message: `Synced ${totalSynced} attendance records successfully`,
        syncedRecords: totalSynced,
        totalRecords: unsyncedRecords.length,
        errorRecords: totalErrors,
        syncSuccessRate: ((totalSynced / unsyncedRecords.length) * 100).toFixed(2) + '%',
        validationResult: validationResult,
        batchResults: syncResults,
        timestamp: new Date().toISOString()
      }

      console.log(`=== ATTENDANCE SYNC COMPLETED ===`)
      console.log(`Success rate: ${finalResult.syncSuccessRate}`)

      return finalResult

    } catch (error) {
      console.error("Attendance sync error:", error)
      return {
        success: false,
        error: error.message,
        syncedRecords: 0,
        validationResult: validationResult
      }
    }
  }

  /**
   * Sync a batch of attendance records to the server
   */
  static async syncAttendanceBatch(records, syncEndpoint, maxRetries = 3) {
    const batchResult = {
      successCount: 0,
      errorCount: 0,
      successfulIds: [],
      errors: []
    }

    for (const record of records) {
      let success = false
      let lastError = null

      // Retry mechanism for each record
      for (let attempt = 1; attempt <= maxRetries && !success; attempt++) {
        try {
          const syncData = {
            id: record.id,
            employee_uid: record.employee_uid,
            id_number: record.id_number,
            id_barcode: record.id_barcode,
            scanned_barcode: record.scanned_barcode,
            clock_type: record.clock_type,
            clock_time: record.clock_time,
            regular_hours: record.regular_hours || 0,
            overtime_hours: record.overtime_hours || 0,
            date: record.date,
            is_late: record.is_late || 0,
            created_at: record.created_at,
            employee_info: {
              first_name: record.first_name,
              last_name: record.last_name,
              department: record.department
            }
          }

          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), 15000) // 15 second timeout

          const response = await fetch(syncEndpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'AttendanceApp/1.0'
            },
            body: JSON.stringify(syncData),
            signal: controller.signal
          })

          clearTimeout(timeoutId)

          if (response.ok) {
            success = true
            batchResult.successCount++
            batchResult.successfulIds.push(record.id)
            console.log(`✅ Synced record ${record.id} (Employee: ${record.employee_uid}, ${record.clock_type})`)
          } else {
            const errorText = await response.text()
            lastError = new Error(`Server error ${response.status}: ${errorText}`)

            if (attempt < maxRetries) {
              console.log(`⚠️  Retry ${attempt}/${maxRetries} for record ${record.id}: ${lastError.message}`)
              await new Promise(resolve => setTimeout(resolve, 1000 * attempt)) // Exponential backoff
            }
          }

        } catch (error) {
          lastError = error
          if (error.name === 'AbortError') {
            lastError = new Error('Request timeout')
          }

          if (attempt < maxRetries) {
            console.log(`⚠️  Retry ${attempt}/${maxRetries} for record ${record.id}: ${lastError.message}`)
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt)) // Exponential backoff
          }
        }
      }

      if (!success) {
        batchResult.errorCount++
        batchResult.errors.push({
          recordId: record.id,
          employeeUid: record.employee_uid,
          error: lastError.message
        })
        console.log(`❌ Failed to sync record ${record.id} after ${maxRetries} attempts: ${lastError.message}`)
      }
    }

    return batchResult
  }

  /**
   * Mark successfully synced records in the database
   */
  static async markRecordsAsSynced(recordIds, db) {
    if (recordIds.length === 0) return

    try {
      const placeholders = recordIds.map(() => '?').join(',')
      const updateQuery = db.prepare(`
        UPDATE attendance 
        SET is_synced = 1, 
            updated_at = CURRENT_TIMESTAMP 
        WHERE id IN (${placeholders})
      `)

      updateQuery.run(...recordIds)
      console.log(`Marked ${recordIds.length} records as synced in database`)

    } catch (error) {
      console.error('Error marking records as synced:', error)
    }
  }

  /**
   * NEW: Quick sync for today's attendance data
   */
  static async syncTodayAttendance(options = {}) {
    const today = new Date().toISOString().split('T')[0]

    return await this.syncAttendanceData({
      ...options,
      dateRange: {
        startDate: today,
        endDate: today
      }
    })
  }

  /**
   * NEW: Sync attendance for a specific employee
   */
  static async syncEmployeeAttendance(employeeUid, dateRange = null, options = {}) {
    return await this.syncAttendanceData({
      ...options,
      employeeUid: employeeUid,
      dateRange: dateRange
    })
  }

  /**
   * NEW: Get sync status for attendance data
   */
  static async getAttendanceSyncStatus(dateRange = null) {
    try {
      const db = getDatabase()

      let query = `
        SELECT 
          COUNT(*) as total_records,
          SUM(CASE WHEN is_synced = 1 THEN 1 ELSE 0 END) as synced_records,
          SUM(CASE WHEN is_synced = 0 THEN 1 ELSE 0 END) as unsynced_records,
          COUNT(DISTINCT employee_uid) as employees_with_records,
          COUNT(DISTINCT date) as dates_with_records,
          MIN(date) as earliest_date,
          MAX(date) as latest_date
        FROM attendance
        WHERE 1=1
      `
      const params = []

      if (dateRange) {
        query += ` AND date BETWEEN ? AND ?`
        params.push(dateRange.startDate, dateRange.endDate)
      }

      const stats = db.prepare(query).get(...params)

      // Get unsynced records by date
      let unsyncedByDateQuery = `
        SELECT 
          date,
          COUNT(*) as unsynced_count,
          COUNT(DISTINCT employee_uid) as employees_count
        FROM attendance 
        WHERE is_synced = 0
      `

      if (dateRange) {
        unsyncedByDateQuery += ` AND date BETWEEN ? AND ?`
      }

      unsyncedByDateQuery += ` GROUP BY date ORDER BY date DESC LIMIT 10`

      const unsyncedByDate = db.prepare(unsyncedByDateQuery).all(...(dateRange ? params : []))

      const syncPercentage = stats.total_records > 0
        ? ((stats.synced_records / stats.total_records) * 100).toFixed(2)
        : 100

      return {
        success: true,
        totalRecords: stats.total_records || 0,
        syncedRecords: stats.synced_records || 0,
        unsyncedRecords: stats.unsynced_records || 0,
        syncPercentage: parseFloat(syncPercentage),
        employeesWithRecords: stats.employees_with_records || 0,
        datesWithRecords: stats.dates_with_records || 0,
        dateRange: {
          earliest: stats.earliest_date,
          latest: stats.latest_date
        },
        unsyncedByDate: unsyncedByDate,
        needsSync: (stats.unsynced_records || 0) > 0
      }

    } catch (error) {
      console.error("Error getting attendance sync status:", error)
      return {
        success: false,
        error: error.message
      }
    }
  }

  // UPDATED: Enhanced auto-sync that includes attendance data validation and sync
  static async startAutoSync(options = {}) {
    const {
      syncEmployees = true,
      syncAttendance = true,
      validateBeforeSync = true,
      syncProfiles = false
    } = options

    const db = getDatabase()
    const settingsStmt = db.prepare("SELECT value FROM settings WHERE key = ?")
    const interval = Number.parseInt(settingsStmt.get("sync_interval")?.value || "300000")

    console.log(`Starting enhanced auto-sync with ${interval}ms interval`)
    console.log(`- Sync employees: ${syncEmployees}`)
    console.log(`- Sync attendance: ${syncAttendance}`)
    console.log(`- Validate before sync: ${validateBeforeSync}`)
    console.log(`- Sync profiles: ${syncProfiles}`)

    // Initial sync
    if (syncEmployees) {
      const employeeSync = await this.syncEmployees()
      if (employeeSync.success) {
        console.log("Initial employee sync completed successfully")
      } else {
        console.error("Initial employee sync failed:", employeeSync.error)
      }
    }

    if (syncAttendance) {
      const attendanceSync = await this.syncAttendanceData({
        validateBeforeSync: validateBeforeSync
      })
      if (attendanceSync.success) {
        console.log(`Initial attendance sync completed: ${attendanceSync.message}`)
      } else {
        console.error("Initial attendance sync failed:", attendanceSync.error)
      }
    }

    if (syncProfiles) {
      const profileSync = await this.syncMissingProfiles()
      if (profileSync.success) {
        console.log("Initial profile sync completed successfully")
      } else {
        console.error("Initial profile sync failed:", profileSync.error)
      }
    }

    // Set up periodic sync
    setInterval(async () => {
      console.log("Running scheduled enhanced sync...")

      // Sync employees
      if (syncEmployees) {
        const employeeResult = await this.syncEmployees()
        if (employeeResult.success) {
          console.log(`Scheduled employee sync: ${employeeResult.message}`)
        } else {
          console.error("Scheduled employee sync failed:", employeeResult.error)
        }
      }

      // Sync attendance with validation
      if (syncAttendance) {
        const attendanceResult = await this.syncAttendanceData({
          validateBeforeSync: validateBeforeSync
        })
        if (attendanceResult.success) {
          console.log(`Scheduled attendance sync: ${attendanceResult.message}`)
        } else {
          console.error("Scheduled attendance sync failed:", attendanceResult.error)
        }
      }

      // Sync missing profiles
      if (syncProfiles) {
        const profileResult = await this.syncMissingProfiles()
        if (profileResult.success && !profileResult.alreadyComplete) {
          console.log(`Scheduled profile sync: ${profileResult.message}`)
        }
      }

    }, interval)

    console.log(`Enhanced auto-sync started with ${interval}ms interval`)
  }

  // Existing profile sync methods remain unchanged...

  static async syncProfileImagesBulk(employees) {
    try {
      const db = getDatabase()
      const settingsStmt = db.prepare("SELECT value FROM settings WHERE key = ?")
      const serverUrl = settingsStmt.get("server_url")?.value

      if (!serverUrl) {
        console.log("Server URL not configured, skipping profile sync")
        return {
          success: false,
          error: "Server URL not configured"
        }
      }

      // Extract base URL from server URL
      const baseUrl = serverUrl.split("/api")[0]
      const employeeUids = employees.map(emp => emp.uid)

      console.log(`Starting bulk profile image sync for ${employees.length} employees...`)

      // Check which profiles are already downloaded
      const profileCheck = await ProfileService.checkProfileImages(employeeUids)

      console.log(`Profile status check: ${profileCheck.downloaded}/${profileCheck.total} already exist locally`)

      if (profileCheck.missingUids.length === 0) {
        console.log("All employee profiles already exist locally - no download needed")
        return {
          success: true,
          downloaded: profileCheck.downloaded,
          total: profileCheck.total,
          message: "All profiles already exist locally",
          alreadyExisted: true
        }
      }

      console.log(`Downloading ${profileCheck.missingUids.length} missing profiles via bulk download...`)

      // Use bulk download for missing profiles
      const bulkResult = await ProfileService.bulkDownloadSpecificEmployees(
        baseUrl,
        profileCheck.missingUids,
        (progress) => {
          console.log(`Bulk profile sync progress: ${progress.stage} - ${progress.message}`)

          if (progress.stage === 'downloaded') {
            console.log("Profile ZIP downloaded, extracting...")
          } else if (progress.stage === 'extracted') {
            console.log(`Extracted ${progress.files ? progress.files.length : 0} files`)
          } else if (progress.stage === 'completed') {
            console.log(`Bulk download completed: ${Object.keys(progress.profiles || {}).length} profiles processed`)
          }
        }
      )

      if (bulkResult.success) {
        const totalDownloaded = profileCheck.downloaded + Object.keys(bulkResult.profiles).length

        console.log(`Bulk profile sync completed successfully:`)
        console.log(`- Previously downloaded: ${profileCheck.downloaded}`)
        console.log(`- Newly downloaded: ${Object.keys(bulkResult.profiles).length}`)
        console.log(`- Total profiles available: ${totalDownloaded}/${employees.length}`)

        return {
          success: true,
          downloaded: totalDownloaded,
          total: employees.length,
          previouslyDownloaded: profileCheck.downloaded,
          newlyDownloaded: Object.keys(bulkResult.profiles).length,
          message: `Bulk sync completed: ${Object.keys(bulkResult.profiles).length} new profiles downloaded`,
          profiles: bulkResult.profiles,
          summary: bulkResult.summary
        }
      } else {
        console.error("Bulk profile download failed, falling back to individual downloads...")

        // Fallback to individual downloads for missing profiles
        const fallbackResult = await this.syncProfileImagesIndividual(
          profileCheck.missingUids.map(uid => employees.find(emp => emp.uid === uid)).filter(Boolean)
        )

        return {
          success: fallbackResult.success,
          downloaded: profileCheck.downloaded + (fallbackResult.downloaded || 0),
          total: employees.length,
          errors: fallbackResult.errors || 0,
          message: `Fallback sync completed after bulk failure: ${fallbackResult.downloaded || 0} additional profiles downloaded`,
          usedFallback: true
        }
      }

    } catch (error) {
      console.error("Bulk profile sync error:", error)

      // Final fallback to individual sync
      console.log("Attempting fallback to individual profile downloads...")

      try {
        const fallbackResult = await this.syncProfileImagesIndividual(employees)
        return {
          success: true,
          downloaded: fallbackResult.downloaded || 0,
          total: employees.length,
          errors: fallbackResult.errors || 0,
          message: `Completed via individual downloads after bulk failure: ${fallbackResult.downloaded || 0} profiles`,
          usedFallback: true,
          bulkError: error.message
        }
      } catch (fallbackError) {
        return {
          success: false,
          error: `Both bulk and individual sync failed. Bulk: ${error.message}, Individual: ${fallbackError.message}`,
          downloaded: 0,
          total: employees.length
        }
      }
    }
  }

  static async syncProfileImagesIndividual(employees) {
    try {
      const db = getDatabase()
      const settingsStmt = db.prepare("SELECT value FROM settings WHERE key = ?")
      const serverUrl = settingsStmt.get("server_url")?.value

      if (!serverUrl) {
        console.log("Server URL not configured, skipping individual profile sync")
        return {
          success: false,
          error: "Server URL not configured"
        }
      }

      // Extract base URL from server URL
      const baseUrl = serverUrl.split("/api")[0]

      let downloadedCount = 0
      let errorCount = 0

      console.log(`Starting individual profile image sync for ${employees.length} employees...`)

      for (const employee of employees) {
        try {
          await ProfileService.downloadAndStoreProfile(employee.uid, baseUrl)
          downloadedCount++
          console.log(`Downloaded profile for employee ${employee.uid} (${downloadedCount}/${employees.length})`)

          // Small delay to prevent overwhelming the server
          await new Promise(resolve => setTimeout(resolve, 250)) // Increased delay for individual downloads
        } catch (error) {
          errorCount++
          console.error(`Failed to download profile for employee ${employee.uid}:`, error.message)
        }
      }

      console.log(`Individual profile sync completed: ${downloadedCount} downloaded, ${errorCount} errors`)

      return {
        success: true,
        downloaded: downloadedCount,
        errors: errorCount,
        total: employees.length
      }
    } catch (error) {
      console.error("Individual profile sync error:", error)
      return {
        success: false,
        error: error.message,
        downloaded: 0,
        errors: 0,
        total: employees.length
      }
    }
  }

  // LEGACY: Keep old method for backward compatibility but mark as deprecated
  static async syncProfileImages(employees) {
    console.warn("syncProfileImages is deprecated, use syncProfileImagesBulk instead")
    return this.syncProfileImagesBulk(employees)
  }

  static async syncMissingProfiles() {
    try {
      const db = getDatabase()

      // Get all employees from database
      const employeesStmt = db.prepare("SELECT uid, first_name, last_name FROM employees WHERE status = 'Active'")
      const employees = employeesStmt.all()

      if (employees.length === 0) {
        return {
          success: true,
          message: "No active employees found",
          downloaded: 0,
          total: 0
        }
      }

      console.log(`Checking for missing profiles among ${employees.length} active employees...`)

      // Check which profiles are missing
      const employeeUids = employees.map(emp => emp.uid)
      const profileCheck = await ProfileService.checkProfileImages(employeeUids)

      if (profileCheck.missingUids.length === 0) {
        return {
          success: true,
          message: "All employee profiles already exist locally",
          downloaded: profileCheck.downloaded,
          total: profileCheck.total,
          alreadyComplete: true
        }
      }

      // Sync only the missing profiles
      const missingEmployees = profileCheck.missingUids.map(uid =>
        employees.find(emp => emp.uid === uid)
      ).filter(Boolean)

      return await this.syncProfileImagesBulk(missingEmployees)

    } catch (error) {
      console.error("Error syncing missing profiles:", error)
      return {
        success: false,
        error: error.message,
        downloaded: 0,
        total: 0
      }
    }
  }

  static async getProfileSyncStatus() {
    try {
      const db = getDatabase()

      // Get all active employees
      const employeesStmt = db.prepare("SELECT uid, first_name, last_name, department FROM employees WHERE status = 'Active'")
      const employees = employeesStmt.all()

      if (employees.length === 0) {
        return {
          success: true,
          totalEmployees: 0,
          profilesDownloaded: 0,
          profilesMissing: 0,
          percentage: 100,
          employees: []
        }
      }

      // Check profile status
      const employeeUids = employees.map(emp => emp.uid)
      const profileCheck = await ProfileService.checkProfileImages(employeeUids)

      // Get detailed profile info
      const allProfilesInfo = await ProfileService.checkAllProfileImages()

      return {
        success: true,
        totalEmployees: employees.length,
        profilesDownloaded: profileCheck.downloaded,
        profilesMissing: profileCheck.missingUids.length,
        percentage: Math.round((profileCheck.downloaded / employees.length) * 100),
        employees: employees.map(emp => ({
          uid: emp.uid,
          name: `${emp.first_name} ${emp.last_name}`,
          department: emp.department,
          hasProfile: profileCheck.downloadedUids.includes(emp.uid)
        })),
        profileDetails: profileCheck.profileDetails,
        allProfilesInfo: allProfilesInfo
      }
    } catch (error) {
      console.error("Error getting profile sync status:", error)
      return {
        success: false,
        error: error.message,
        totalEmployees: 0,
        profilesDownloaded: 0,
        profilesMissing: 0,
        percentage: 0
      }
    }
  }

  static async testConnection(serverUrl) {
    try {
      console.log(`Testing connection to: ${serverUrl}`)

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10000) // 10 second timeout for test

      const response = await fetch(serverUrl, {
        method: 'HEAD', // Just check if server responds
        headers: {
          "User-Agent": "AttendanceApp/1.0"
        },
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      return {
        success: response.ok,
        status: response.status,
        message: response.ok ? 'Connection successful' : `Server returned status ${response.status}`
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          error: 'Connection test timed out after 10 seconds'
        }
      }

      return {
        success: false,
        error: error.message
      }
    }
  }

  // NEW: Test attendance sync endpoint
  static async testAttendanceSyncConnection(serverUrl) {
    try {
      const baseUrl = serverUrl.split("/api")[0]
      const syncUrl = `${baseUrl}/api/attendance/sync`

      console.log(`Testing attendance sync endpoint: ${syncUrl}`)

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000) // 15 second timeout

      const response = await fetch(syncUrl, {
        method: 'OPTIONS', // Check if endpoint accepts POST requests
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "AttendanceApp/1.0"
        },
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      return {
        success: response.ok || response.status === 404, // 404 might mean endpoint exists but no OPTIONS handler
        status: response.status,
        message: response.ok ? 'Attendance sync endpoint is accessible' :
          response.status === 404 ? 'Attendance sync endpoint exists (no OPTIONS support)' :
            `Attendance sync endpoint returned status ${response.status}`
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          error: 'Attendance sync test timed out after 15 seconds'
        }
      }

      return {
        success: false,
        error: error.message
      }
    }
  }

  static async testBulkProfileConnection(serverUrl) {
    try {
      const baseUrl = serverUrl.split("/api")[0]
      const bulkUrl = `${baseUrl}/api/profile/bulk/simple`

      console.log(`Testing bulk profile endpoint: ${bulkUrl}`)

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000) // 15 second timeout

      const response = await fetch(bulkUrl, {
        method: 'GET',
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "AttendanceApp/1.0"
        },
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (response.ok) {
        const data = await response.json()
        return {
          success: true,
          status: response.status,
          message: 'Bulk profile endpoint is working',
          employeeCount: data.data ? data.data.statistics.total_employees : 0
        }
      } else {
        return {
          success: false,
          status: response.status,
          message: `Bulk profile endpoint returned status ${response.status}`
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          error: 'Bulk profile test timed out after 15 seconds'
        }
      }

      return {
        success: false,
        error: error.message
      }
    }
  }

  // NEW: Comprehensive connection test for all endpoints
  static async testAllConnections(serverUrl) {
    console.log(`Running comprehensive connection tests...`)

    const results = {
      employee_sync: await this.testConnection(serverUrl),
      attendance_sync: await this.testAttendanceSyncConnection(serverUrl),
      bulk_profiles: await this.testBulkProfileConnection(serverUrl),
      overall_success: false,
      timestamp: new Date().toISOString()
    }

    // Determine overall success
    results.overall_success = results.employee_sync.success &&
      (results.attendance_sync.success || results.attendance_sync.status === 404) &&
      results.bulk_profiles.success

    console.log(`Connection test results:`)
    console.log(`- Employee sync: ${results.employee_sync.success ? '✅' : '❌'} ${results.employee_sync.message || results.employee_sync.error}`)
    console.log(`- Attendance sync: ${results.attendance_sync.success ? '✅' : '❌'} ${results.attendance_sync.message || results.attendance_sync.error}`)
    console.log(`- Bulk profiles: ${results.bulk_profiles.success ? '✅' : '❌'} ${results.bulk_profiles.message || results.bulk_profiles.error}`)
    console.log(`- Overall: ${results.overall_success ? '✅ All systems operational' : '❌ Some systems have issues'}`)

    return results
  }

  // Start auto-sync for profiles only (separate from employee data)
  static startAutoProfileSync(intervalMs = 3600000) { // Default 1 hour
    console.log(`Starting auto profile sync with ${intervalMs}ms interval`)

    setInterval(async () => {
      console.log("Running scheduled profile sync...")
      const result = await this.syncMissingProfiles()

      if (result.success) {
        if (result.alreadyComplete) {
          console.log("Scheduled profile sync: All profiles up to date")
        } else {
          console.log(`Scheduled profile sync completed: ${result.message}`)
        }
      } else {
        console.error("Scheduled profile sync failed:", result.error)
      }
    }, intervalMs)

    console.log(`Auto profile sync started with ${intervalMs}ms interval`)
  }

  /**
   * NEW: Manual validation trigger (can be called from UI)
   */
  static async validateAttendanceDataManual(options = {}) {
    const {
      startDate = null,
      endDate = null,
      employeeUid = null,
      autoCorrect = true
    } = options

    console.log(`=== MANUAL ATTENDANCE DATA VALIDATION ===`)

    try {
      const validationResult = await validateAttendanceData(
        startDate,
        endDate,
        employeeUid,
        {
          autoCorrect: autoCorrect,
          updateSyncStatus: true,
          validateStatistics: true,
          rebuildSummary: true
        }
      )

      console.log(`Manual validation completed:`)
      console.log(`- Total records: ${validationResult.totalRecords}`)
      console.log(`- Valid: ${validationResult.validRecords}`)
      console.log(`- Corrected: ${validationResult.correctedRecords}`)
      console.log(`- Errors: ${validationResult.errorRecords}`)

      return validationResult

    } catch (error) {
      console.error("Manual validation error:", error)
      return {
        success: false,
        error: error.message,
        totalRecords: 0,
        validRecords: 0,
        correctedRecords: 0,
        errorRecords: 0
      }
    }
  }

  /**
   * NEW: Get comprehensive sync dashboard data
   */
  static async getSyncDashboard() {
    try {
      console.log(`Generating sync dashboard data...`)

      // Get attendance sync status
      const attendanceStatus = await this.getAttendanceSyncStatus()

      // Get profile sync status
      const profileStatus = await this.getProfileSyncStatus()

      // Get last sync times
      const db = getDatabase()
      const lastSyncStmt = db.prepare("SELECT key, value FROM settings WHERE key IN ('last_sync', 'last_attendance_sync')")
      const syncTimes = {}
      lastSyncStmt.all().forEach(row => {
        syncTimes[row.key] = row.value ? new Date(parseInt(row.value)).toISOString() : null
      })

      // Get validation status for recent data (last 7 days)
      const sevenDaysAgo = new Date()
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
      const recentValidationResult = await validateAttendanceData(
        sevenDaysAgo.toISOString().split('T')[0],
        new Date().toISOString().split('T')[0],
        null,
        { autoCorrect: false } // Don't correct, just check
      )

      return {
        success: true,
        attendance: {
          ...attendanceStatus,
          lastSync: syncTimes.last_attendance_sync,
          recentValidation: {
            totalRecords: recentValidationResult.totalRecords,
            validRecords: recentValidationResult.validRecords,
            issueRecords: recentValidationResult.correctedRecords + recentValidationResult.errorRecords,
            dataIntegrityPercentage: recentValidationResult.totalRecords > 0
              ? ((recentValidationResult.validRecords / recentValidationResult.totalRecords) * 100).toFixed(2)
              : 100
          }
        },
        profiles: {
          ...profileStatus,
          lastSync: syncTimes.last_sync
        },
        lastEmployeeSync: syncTimes.last_sync,
        systemHealth: {
          attendanceDataIntegrity: recentValidationResult.totalRecords > 0
            ? ((recentValidationResult.validRecords / recentValidationResult.totalRecords) * 100).toFixed(2)
            : 100,
          syncUpToDate: (attendanceStatus.unsyncedRecords || 0) === 0,
          profilesComplete: (profileStatus.profilesMissing || 0) === 0
        },
        timestamp: new Date().toISOString()
      }

    } catch (error) {
      console.error("Error generating sync dashboard:", error)
      return {
        success: false,
        error: error.message
      }
    }
  }
}

module.exports = SyncService