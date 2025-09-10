const fetch = require("node-fetch")
const Employee = require("../database/models/employee")
const ProfileService = require("./profileService")
const { getDatabase } = require("../database/setup")

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
      } else if (data.data && Array.isArray(data.data)) {
        employees = data.data
      } else {
        throw new Error("Invalid response format")
      }

      console.log(`Received ${employees.length} employee records`)

      // Filter and map employee data
      const mappedEmployees = employees
        .map((emp) => ({
          uid: emp.uid,
          id_number: emp.id_number,
          id_barcode: emp.id_barcode,
          first_name: emp.first_name,
          middle_name: emp.middle_name,
          last_name: emp.last_name,
          email: emp.email,
          department: emp.department,
          status: emp.status || "Active",
          profile_picture: emp.profile_picture,
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

  // NEW: Bulk profile sync method - much more efficient
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

  // UPDATED: Individual profile sync method (now used as fallback only)
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

  // NEW: Sync only missing profiles (useful for partial syncs)
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

  // NEW: Get profile sync status
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

  // NEW: Test bulk profile download endpoint
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

  static async startAutoSync() {
    const db = getDatabase()
    const settingsStmt = db.prepare("SELECT value FROM settings WHERE key = ?")
    const interval = Number.parseInt(settingsStmt.get("sync_interval")?.value || "300000")

    console.log(`Starting auto-sync with ${interval}ms interval`)

    // Initial sync
    const initialSync = await this.syncEmployees()
    if (initialSync.success) {
      console.log("Initial sync completed successfully")
    } else {
      console.error("Initial sync failed:", initialSync.error)
    }

    // Set up periodic sync
    setInterval(async () => {
      console.log("Running scheduled sync...")
      const result = await this.syncEmployees()
      if (result.success) {
        console.log(`Scheduled sync completed: ${result.message}`)
      } else {
        console.error("Scheduled sync failed:", result.error)
      }
    }, interval)

    console.log(`Auto-sync started with ${interval}ms interval`)
  }

  // NEW: Start auto-sync for profiles only (separate from employee data)
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
}

module.exports = SyncService