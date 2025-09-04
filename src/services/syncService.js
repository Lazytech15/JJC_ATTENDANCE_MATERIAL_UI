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

      // Start profile sync in background (don't await to avoid blocking)
      this.syncProfileImages(mappedEmployees).catch(error => {
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

  static async syncProfileImages(employees) {
    try {
      const db = getDatabase()
      const settingsStmt = db.prepare("SELECT value FROM settings WHERE key = ?")
      const serverUrl = settingsStmt.get("server_url")?.value

      if (!serverUrl) {
        console.log("Server URL not configured, skipping profile sync")
        return
      }

      // Extract base URL from server URL
      const baseUrl = serverUrl.split("/api")[0]

      let downloadedCount = 0
      let errorCount = 0

      console.log(`Starting profile image sync for ${employees.length} employees...`)

      for (const employee of employees) {
        try {
          await ProfileService.downloadAndStoreProfile(employee.uid, baseUrl)
          downloadedCount++
          console.log(`Downloaded profile for employee ${employee.uid}`)
          
          // Small delay to prevent overwhelming the server
          await new Promise(resolve => setTimeout(resolve, 100))
        } catch (error) {
          errorCount++
          console.error(`Failed to download profile for employee ${employee.uid}:`, error.message)
        }
      }

      console.log(`Profile sync completed: ${downloadedCount} downloaded, ${errorCount} errors`)
      
      return {
        success: true,
        downloaded: downloadedCount,
        errors: errorCount
      }
    } catch (error) {
      console.error("Profile sync error:", error)
      return {
        success: false,
        error: error.message
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
}

module.exports = SyncService