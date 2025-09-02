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

      const response = await fetch(serverUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 10000,
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

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

      // Insert employees into database
      Employee.insertMany(mappedEmployees)

      await this.syncProfileImages(mappedEmployees)

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

      for (const employee of employees) {
        try {
          await ProfileService.downloadAndStoreProfile(employee.uid, baseUrl)
          downloadedCount++
          console.log(`Downloaded profile for employee ${employee.uid}`)
        } catch (error) {
          errorCount++
          console.error(`Failed to download profile for employee ${employee.uid}:`, error.message)
        }
      }

      console.log(`Profile sync completed: ${downloadedCount} downloaded, ${errorCount} errors`)
    } catch (error) {
      console.error("Profile sync error:", error)
    }
  }

  static async startAutoSync() {
    const db = getDatabase()
    const settingsStmt = db.prepare("SELECT value FROM settings WHERE key = ?")
    const interval = Number.parseInt(settingsStmt.get("sync_interval")?.value || "300000")

    // Initial sync
    await this.syncEmployees()

    // Set up periodic sync
    setInterval(async () => {
      await this.syncEmployees()
    }, interval)

    console.log(`Auto-sync started with ${interval}ms interval`)
  }
}

module.exports = SyncService
