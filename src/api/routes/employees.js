// controllers/employeeController.js
const Employee = require("../../database/models/employee")
const SyncService = require("../../services/syncService")
const ProfileService = require("../../services/profileService")

/**
 * Get all employees
 * Now uses cache for instant response
 */
async function getEmployees() {
  try {
    // Ensure cache is loaded
    await Employee.ensureCacheLoaded()
    
    const employees = Employee.getAll()
    return { success: true, data: employees }
  } catch (error) {
    console.error("Error getting employees:", error)
    return { success: false, error: error.message }
  }
}

/**
 * Sync employees from external source
 * Automatically refreshes cache after sync
 */
async function syncEmployees() {
  const result = await SyncService.syncEmployees()
  
  // Refresh cache after sync
  if (result.success) {
    await Employee.refreshCache()
  }
  
  return result
}

/**
 * Check profile images
 * Uses cached employee data
 */
async function checkProfileImages() {
  try {
    // Ensure cache is loaded
    await Employee.ensureCacheLoaded()
    
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
    const employeeUids = employees.map(emp => {
      return emp.uid || emp.id_number || emp.id || emp.employee_uid
    }).filter(uid => uid != null)

    console.log(`Checking profiles for ${employeeUids.length} employees`)

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

/**
 * Get cache statistics
 */
async function getCacheStats() {
  try {
    const stats = Employee.getCacheStats()
    return { success: true, data: stats }
  } catch (error) {
    console.error("Error getting cache stats:", error)
    return { success: false, error: error.message }
  }
}

/**
 * Manually refresh cache
 */
async function refreshCache() {
  try {
    await Employee.refreshCache()
    return { success: true, message: "Cache refreshed successfully" }
  } catch (error) {
    console.error("Error refreshing cache:", error)
    return { success: false, error: error.message }
  }
}

module.exports = {
  getEmployees,
  syncEmployees,
  checkProfileImages,
  getCacheStats,
  refreshCache,
}