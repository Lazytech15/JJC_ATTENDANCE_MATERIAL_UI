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

    // Otherwise, fetch from database (fallback)
    const db = getDatabase()
    const stmt = db.prepare("SELECT * FROM employees WHERE status = ? ORDER BY first_name, last_name")
    return stmt.all("Active")
  }

  /**
   * Find by ID number (from cache)
   */
  static findByIdNumber(idNumber) {
    if (employeeCache.isLoaded()) {
      return employeeCache.findByIdNumber(idNumber)
    }

    // Fallback to database
    const db = getDatabase()
    const stmt = db.prepare("SELECT * FROM employees WHERE id_number = ? AND status = ?")
    return stmt.get(idNumber, "Active")
  }

  /**
   * Find by barcode (from cache)
   */
  static findByBarcode(barcode) {
    if (employeeCache.isLoaded()) {
      return employeeCache.findByBarcode(barcode)
    }

    // Fallback to database
    const db = getDatabase()
    const stmt = db.prepare("SELECT * FROM employees WHERE id_barcode = ? AND status = ?")
    return stmt.get(barcode, "Active")
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
   * Insert or update many employees
   * This also refreshes the cache
   */
  static insertMany(employees) {
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

    const result = transaction(employees)

    // Refresh cache after insert
    employeeCache.load(this)

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