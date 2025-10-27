// services/employeeCache.js
class EmployeeCache {
  constructor() {
    this.employees = null
    this.employeesByIdNumber = new Map()
    this.employeesByBarcode = new Map()
    this.employeesByUid = new Map()
    this.lastUpdated = null
    this.isLoading = false
  }

  /**
   * Load all employees into cache
   */
  async load(Employee) {
    if (this.isLoading) {
      // Wait for existing load to complete
      while (this.isLoading) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return
    }

    this.isLoading = true
    try {
      console.log('Loading employees into cache...')
      const employees = Employee.getAll()
      
      // Clear existing cache
      this.employees = employees
      this.employeesByIdNumber.clear()
      this.employeesByBarcode.clear()
      this.employeesByUid.clear()

      // Build lookup maps for O(1) access
      employees.forEach(emp => {
        if (emp.id_number) {
          this.employeesByIdNumber.set(emp.id_number, emp)
        }
        if (emp.id_barcode) {
          this.employeesByBarcode.set(emp.id_barcode, emp)
        }
        if (emp.uid) {
          this.employeesByUid.set(emp.uid, emp)
        }
      })

      this.lastUpdated = new Date()
      console.log(`Cached ${employees.length} employees`)
    } finally {
      this.isLoading = false
    }
  }

  /**
   * Get all employees from cache
   */
  getAll() {
    return this.employees || []
  }

  /**
   * Find employee by ID number (O(1) lookup)
   */
  findByIdNumber(idNumber) {
    return this.employeesByIdNumber.get(idNumber) || null
  }

  /**
   * Find employee by barcode (O(1) lookup)
   */
  findByBarcode(barcode) {
    return this.employeesByBarcode.get(barcode) || null
  }

  /**
   * Find employee by UID (O(1) lookup)
   */
  findByUid(uid) {
    return this.employeesByUid.get(uid) || null
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      totalEmployees: this.employees?.length || 0,
      lastUpdated: this.lastUpdated,
      cacheAge: this.lastUpdated 
        ? Math.floor((Date.now() - this.lastUpdated.getTime()) / 1000) 
        : null,
      isLoaded: this.employees !== null
    }
  }

  /**
   * Clear the cache
   */
  clear() {
    this.employees = null
    this.employeesByIdNumber.clear()
    this.employeesByBarcode.clear()
    this.employeesByUid.clear()
    this.lastUpdated = null
    console.log('Employee cache cleared')
  }

  /**
   * Check if cache is loaded
   */
  isLoaded() {
    return this.employees !== null
  }
}

// Export singleton instance
module.exports = new EmployeeCache()