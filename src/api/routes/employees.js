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
    
    if (!employees || employees.length === 0) {
      return {
        success: true,
        total: 0,
        downloaded: 0,
        percentage: 0,
        downloadedUids: [],
        missingUids: [],
        profileDetails: {}
      }
    }

    // Extract employee UIDs for bulk checking
    // Use the appropriate field - could be uid, id_number, or id depending on your schema
    const employeeUids = employees.map(emp => {
      // Adjust this based on your employee schema
      // Common fields are: emp.uid, emp.id_number, emp.id
      return emp.uid || emp.id_number || emp.id || emp.employee_uid || emp.id_number
    }).filter(uid => uid != null) // Remove any null/undefined values

    console.log(`Checking profiles for ${employeeUids.length} employees:`, employeeUids)

    // Use the bulk profile checking method from ProfileService
    const result = await ProfileService.checkProfileImages(employeeUids)

    return result

  } catch (error) {
    console.error("Error checking profile images:", error)
    return { 
      success: false, 
      error: error.message,
      total: 0,
      downloaded: 0,
      percentage: 0,
      downloadedUids: [],
      missingUids: []
    }
  }
}

module.exports = {
  getEmployees,
  syncEmployees,
  checkProfileImages,
}