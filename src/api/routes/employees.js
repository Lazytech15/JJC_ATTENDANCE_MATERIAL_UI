const Employee = require("../../database/models/employee")
const SyncService = require("../../services/syncService")
const ProfileService = require("../../services/profileService")

async function getEmployees() {
  try {
    const employees = Employee.getAll()
    return { success: true, data: employees }
  } catch (error) {
    console.error("Error getting employees:", error)
    return { success: false, error: error.message }
  }
}

async function syncEmployees() {
  return await SyncService.syncEmployees()
}

async function checkProfileImages() {
  try {
    const employees = Employee.getAll()
    let downloadedCount = 0

    for (const employee of employees) {
      const hasProfile = await ProfileService.profileExists(employee.id_number)
      if (hasProfile) {
        downloadedCount++
      }
    }

    return {
      success: true,
      total: employees.length,
      downloaded: downloadedCount,
    }
  } catch (error) {
    console.error("Error checking profile images:", error)
    return { success: false, error: error.message }
  }
}

module.exports = {
  getEmployees,
  syncEmployees,
  checkProfileImages,
}
