// database/models/employee.js
const { getDatabase } = require("../setup")
const employeeCache = require("../../services/employeeCache")

class Employee {
  /**
   * Initialize cache on first use
   */
  static async ensureCacheLoaded() {
    if (!employeeCache.isLoaded()) {
      await employeeCache.load(this)
    }
  }

  /**
   * Get all employees (from cache)
   */
  static getAll() {
    // If cache is loaded, return from cache
    if (employeeCache.isLoaded()) {
      return employeeCache.getAll()
    }

  const db = getDatabase()
  const stmt = db.prepare("SELECT * FROM employees ORDER BY last_name, first_name")
  return stmt.all()
}

  /**
   * Find by ID number (from cache)
   */
static findByIdNumber(idNumber) {
  if (employeeCache.isLoaded()) {
    return employeeCache.findByIdNumber(idNumber)
  }

  // Fallback to database - REMOVED status filter
  const db = getDatabase()
  const stmt = db.prepare("SELECT * FROM employees WHERE id_number = ?")
  return stmt.get(idNumber)
}

  /**
   * Find by barcode (from cache)
   */
static findByBarcode(barcode) {
  if (employeeCache.isLoaded()) {
    return employeeCache.findByBarcode(barcode)
  }

  // Fallback to database - REMOVED status filter to allow checking inactive employees
  const db = getDatabase()
  const stmt = db.prepare("SELECT * FROM employees WHERE id_barcode = ?")
  return stmt.get(barcode)
}

  /**
   * Find by UID (from cache)
   */
  static findByUid(uid) {
    if (employeeCache.isLoaded()) {
      return employeeCache.findByUid(uid)
    }

    // Fallback to database
    const db = getDatabase()
    const stmt = db.prepare("SELECT * FROM employees WHERE uid = ?")
    return stmt.get(uid)
  }

  /**
   * ✅ FIXED: Insert or update many employees
   * This also refreshes the cache ASYNCHRONOUSLY
   */
  static async insertMany(employees) {
    const db = getDatabase()
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO employees 
      (uid, id_number, id_barcode, first_name, middle_name, last_name, email, department, status, profile_picture, face_descriptor, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `)

    const transaction = db.transaction((employees) => {
      for (const emp of employees) {
        stmt.run(
          emp.uid,
          emp.id_number,
          emp.id_barcode,
          emp.first_name,
          emp.middle_name,
          emp.last_name,
          emp.email,
          emp.department,
          emp.status || "Active",
          emp.profile_picture,
          emp.face_descriptor,
        )
      }
    })

    // Execute the transaction
    const result = transaction(employees)

    // ✅ FIX: Wait for cache to actually refresh
    console.log('Database updated, refreshing employee cache...')
    await employeeCache.load(this)
    console.log('✓ Employee cache refreshed successfully')

    return result
  }

  /**
   * Get count (from cache if available)
   */
  static getCount() {
    if (employeeCache.isLoaded()) {
      return employeeCache.getAll().length
    }

    const db = getDatabase()
    const stmt = db.prepare("SELECT COUNT(*) as count FROM employees WHERE status = ?")
    return stmt.get("Active").count
  }

  /**
   * Manually refresh the cache
   */
  static async refreshCache() {
    await employeeCache.load(this)
  }

  /**
   * Get cache statistics
   */
  static getCacheStats() {
    return employeeCache.getStats()
  }

  /**
   * Clear the cache
   */
  static clearCache() {
    employeeCache.clear()
  }
}

module.exports = Employee