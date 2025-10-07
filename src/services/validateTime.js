const timeCalculator = require("./timeCalculator")
const { getDatabase, updateDailyAttendanceSummary } = require("../database/setup")

/**
 * Attendance Data Validation Service
 * Validates and corrects attendance records based on timeCalculator logic
 */
class AttendanceValidationService {
  constructor(db = null) {
    this.db = db || getDatabase()
    this.validationResults = {
      totalRecords: 0,
      validRecords: 0,
      correctedRecords: 0,
      errorRecords: 0,
      corrections: []
    }
  }

  /**
 * Main validation function - validates all attendance records for a date range
 */
async validateAttendanceData(startDate = null, endDate = null, employeeUid = null, options = {}) {
  const {
    autoCorrect = true,
    updateSyncStatus = true,
    validateStatistics = false,
    rebuildSummary = true,
    apply8HourRule = true  // NEW: Enable/disable 8-hour rule application
  } = options

  console.log(`=== STARTING ATTENDANCE DATA VALIDATION ===`)
  console.log(`Date range: ${startDate || 'all'} to ${endDate || 'all'}`)
  console.log(`Employee: ${employeeUid || 'all'}`)
  console.log(`Auto-correct: ${autoCorrect}`)
  console.log(`Apply 8-hour rule: ${apply8HourRule}`)
  
  this.resetValidationResults()

  try {
    // Get all attendance records to validate
    const attendanceRecords = this.getAttendanceRecordsToValidate(startDate, endDate, employeeUid)
    
    console.log(`Found ${attendanceRecords.length} attendance records to validate`)
    this.validationResults.totalRecords = attendanceRecords.length

    // Group records by employee and date for proper validation
    const groupedRecords = this.groupRecordsByEmployeeAndDate(attendanceRecords)

    // Validate each employee's daily attendance
    for (const [employeeUid, employeeDates] of Object.entries(groupedRecords)) {
      for (const [date, records] of Object.entries(employeeDates)) {
        await this.validateEmployeeDailyAttendance(
          parseInt(employeeUid), 
          date, 
          records, 
          { autoCorrect, updateSyncStatus, apply8HourRule }  // Pass apply8HourRule option
        )
      }
    }

    // Validate statistics if requested
    if (validateStatistics) {
      await this.validateAttendanceStatistics(startDate, endDate, employeeUid, { autoCorrect })
    }

    // Rebuild daily summary if requested
    if (rebuildSummary && this.validationResults.correctedRecords > 0) {
      console.log(`Rebuilding daily attendance summary for corrected records...`)
      const { successCount } = require('../database/setup').rebuildDailyAttendanceSummary(
        startDate || '2024-01-01', 
        endDate || new Date().toISOString().split('T')[0], 
        this.db
      )
      console.log(`Rebuilt ${successCount} daily summary records`)
    }

    console.log(`=== VALIDATION COMPLETED ===`)
    this.logValidationSummary()

    return this.validationResults

  } catch (error) {
    console.error('Error during attendance validation:', error)
    throw error
  }
}

  /**
 * Validate a single employee's attendance for a specific date
 */
async validateEmployeeDailyAttendance(employeeUid, date, records, options = {}) {
  const { autoCorrect = true, updateSyncStatus = true, apply8HourRule = true } = options
  
  console.log(`\n--- Validating ${records.length} records for employee ${employeeUid} on ${date} ---`)

  // Sort records by clock time
  const sortedRecords = records.sort((a, b) => new Date(a.clock_time) - new Date(b.clock_time))
  
  // Validate each clock-out record
  for (let i = 0; i < sortedRecords.length; i++) {
    const record = sortedRecords[i]
    
    // Only validate clock-out records (they contain the calculated hours)
    if (record.clock_type.endsWith('_out')) {
      await this.validateClockOutRecord(record, sortedRecords, { 
        autoCorrect, 
        updateSyncStatus,
        apply8HourRule  // Pass the option down
      })
    }
  }
}

  /**
   * Validate a single clock-out record
   */
  async validateClockOutRecord(clockOutRecord, allRecords, options = {}) {
    const { autoCorrect = true, updateSyncStatus = true } = options
    
    try {
      console.log(`\nValidating clock-out: ${clockOutRecord.clock_type} at ${clockOutRecord.clock_time}`)
      
      // Find the corresponding clock-in record
      const clockInType = clockOutRecord.clock_type.replace('_out', '_in')
      const clockInRecord = this.findCorrespondingClockIn(clockOutRecord, allRecords, clockInType)
      
      if (!clockInRecord) {
        console.log(`WARNING: No corresponding clock-in found for ${clockOutRecord.clock_type}`)
        this.validationResults.errorRecords++
        return false
      }

      console.log(`Found clock-in: ${clockInRecord.clock_type} at ${clockInRecord.clock_time}`)

      // Calculate expected hours using timeCalculator
      const expectedHours = timeCalculator.calculateHours(
        clockOutRecord.clock_type,
        new Date(clockOutRecord.clock_time),
        new Date(clockInRecord.clock_time)
      )

      console.log(`Expected: Regular=${expectedHours.regularHours}, Overtime=${expectedHours.overtimeHours}`)
      console.log(`Actual: Regular=${clockOutRecord.regular_hours || 0}, Overtime=${clockOutRecord.overtime_hours || 0}`)

      // Check for discrepancies
      const regularHoursDiff = Math.abs((clockOutRecord.regular_hours || 0) - expectedHours.regularHours)
      const overtimeHoursDiff = Math.abs((clockOutRecord.overtime_hours || 0) - expectedHours.overtimeHours)
      
      const tolerance = 0.01 // Allow 0.01 hour difference for rounding
      const hasDiscrepancy = regularHoursDiff > tolerance || overtimeHoursDiff > tolerance

      if (hasDiscrepancy) {
        console.log(`❌ DISCREPANCY FOUND:`)
        console.log(`   Regular hours difference: ${regularHoursDiff.toFixed(4)}`)
        console.log(`   Overtime hours difference: ${overtimeHoursDiff.toFixed(4)}`)
        
        this.validationResults.correctedRecords++
        this.validationResults.corrections.push({
          employeeUid: clockOutRecord.employee_uid,
          date: clockOutRecord.date,
          recordId: clockOutRecord.id,
          clockType: clockOutRecord.clock_type,
          clockTime: clockOutRecord.clock_time,
          originalRegular: clockOutRecord.regular_hours || 0,
          originalOvertime: clockOutRecord.overtime_hours || 0,
          correctedRegular: expectedHours.regularHours,
          correctedOvertime: expectedHours.overtimeHours,
          regularDiff: regularHoursDiff,
          overtimeDiff: overtimeHoursDiff
        })

        if (autoCorrect) {
          await this.correctAttendanceRecord(
            clockOutRecord.id, 
            expectedHours, 
            updateSyncStatus
          )
          console.log(`✅ CORRECTED: Updated record ID ${clockOutRecord.id}`)
        } else {
          console.log(`⚠️  DISCREPANCY LOGGED: Auto-correction disabled`)
        }

        return false
      } else {
        console.log(`✅ VALID: Hours calculation matches expected values`)
        this.validationResults.validRecords++
        return true
      }

    } catch (error) {
      console.error(`Error validating clock-out record ${clockOutRecord.id}:`, error)
      this.validationResults.errorRecords++
      return false
    }
  }

  /**
   * Find the corresponding clock-in record for a clock-out
   */
  findCorrespondingClockIn(clockOutRecord, allRecords, clockInType) {
    const clockOutTime = new Date(clockOutRecord.clock_time)
    
    // Find all clock-in records of the expected type before this clock-out
    const candidateClockIns = allRecords.filter(record => 
      record.clock_type === clockInType &&
      new Date(record.clock_time) <= clockOutTime
    ).sort((a, b) => new Date(b.clock_time) - new Date(a.clock_time))

    if (candidateClockIns.length === 0) {
      return null
    }

    // Return the most recent clock-in of the correct type
    return candidateClockIns[0]
  }

  /**
   * Correct an attendance record with new calculated hours
   */
  async correctAttendanceRecord(recordId, expectedHours, updateSyncStatus = true) {
    try {
      const updateQuery = this.db.prepare(`
        UPDATE attendance 
        SET 
          regular_hours = ?,
          overtime_hours = ?,
          is_synced = ?
        WHERE id = ?
      `)
      
      const syncStatus = updateSyncStatus ? 0 : 1 // Set to 0 (false) if we should update sync status
      
      updateQuery.run(
        expectedHours.regularHours,
        expectedHours.overtimeHours,
        syncStatus,
        recordId
      )
      
      console.log(`Updated record ${recordId}: Regular=${expectedHours.regularHours}, Overtime=${expectedHours.overtimeHours}, Synced=${syncStatus}`)
      
    } catch (error) {
      console.error(`Error correcting attendance record ${recordId}:`, error)
      throw error
    }
  }

  /**
   * Validate attendance statistics table against attendance records
   */
  async validateAttendanceStatistics(startDate = null, endDate = null, employeeUid = null, options = {}) {
    const { autoCorrect = true } = options
    
    console.log(`\n=== VALIDATING ATTENDANCE STATISTICS ===`)
    
    try {
      // Get all statistics records to validate
      let statsQuery = `
        SELECT s.*, a.clock_time as clock_out_time, a.regular_hours, a.overtime_hours
        FROM attendance_statistics s
        JOIN attendance a ON s.clock_out_id = a.id
        WHERE 1=1
      `
      const params = []
      
      if (startDate) {
        statsQuery += ` AND s.date >= ?`
        params.push(startDate)
      }
      
      if (endDate) {
        statsQuery += ` AND s.date <= ?`
        params.push(endDate)
      }
      
      if (employeeUid) {
        statsQuery += ` AND s.employee_uid = ?`
        params.push(employeeUid)
      }
      
      statsQuery += ` ORDER BY s.employee_uid, s.date, s.clock_in_time`
      
      const statsRecords = this.db.prepare(statsQuery).all(...params)
      
      console.log(`Found ${statsRecords.length} statistics records to validate`)
      
      let validStats = 0
      let correctedStats = 0
      
      for (const stat of statsRecords) {
        const isValid = await this.validateStatisticsRecord(stat, { autoCorrect })
        if (isValid) {
          validStats++
        } else {
          correctedStats++
        }
      }
      
      console.log(`Statistics validation complete: ${validStats} valid, ${correctedStats} corrected`)
      
    } catch (error) {
      console.error('Error validating attendance statistics:', error)
    }
  }

  /**
   * Validate a single statistics record
   */
  async validateStatisticsRecord(stat, options = {}) {
    const { autoCorrect = true } = options
    
    try {
      // Check if hours match between statistics and attendance records
      const hoursDiff = Math.abs((stat.regular_hours + stat.overtime_hours) - (stat.regular_hours + stat.overtime_hours))
      const tolerance = 0.01
      
      if (hoursDiff > tolerance) {
        console.log(`Statistics record ${stat.id} has hour mismatch: ${hoursDiff}`)
        
        if (autoCorrect) {
          // Recalculate statistics if needed
          // This would require more complex logic to regenerate the statistics
          console.log(`Statistics correction not implemented yet for record ${stat.id}`)
        }
        
        return false
      }
      
      return true
      
    } catch (error) {
      console.error(`Error validating statistics record ${stat.id}:`, error)
      return false
    }
  }

  /**
   * Get attendance records that need validation
   */
  getAttendanceRecordsToValidate(startDate, endDate, employeeUid) {
    let query = `
      SELECT 
        id, employee_uid, clock_type, clock_time, 
        regular_hours, overtime_hours, date, is_synced
      FROM attendance 
      WHERE 1=1
    `
    const params = []
    
    if (startDate) {
      query += ` AND date >= ?`
      params.push(startDate)
    }
    
    if (endDate) {
      query += ` AND date <= ?`
      params.push(endDate)
    }
    
    if (employeeUid) {
      query += ` AND employee_uid = ?`
      params.push(employeeUid)
    }
    
    query += ` ORDER BY employee_uid, date, clock_time`
    
    return this.db.prepare(query).all(...params)
  }

  /**
   * Group attendance records by employee and date
   */
  groupRecordsByEmployeeAndDate(records) {
    const grouped = {}
    
    records.forEach(record => {
      const employeeUid = record.employee_uid
      const date = record.date
      
      if (!grouped[employeeUid]) {
        grouped[employeeUid] = {}
      }
      
      if (!grouped[employeeUid][date]) {
        grouped[employeeUid][date] = []
      }
      
      grouped[employeeUid][date].push(record)
    })
    
    return grouped
  }

  /**
   * Reset validation results
   */
  resetValidationResults() {
    this.validationResults = {
      totalRecords: 0,
      validRecords: 0,
      correctedRecords: 0,
      errorRecords: 0,
      corrections: []
    }
  }

  /**
   * Log validation summary
   */
  logValidationSummary() {
    console.log(`\n=== VALIDATION SUMMARY ===`)
    console.log(`Total records processed: ${this.validationResults.totalRecords}`)
    console.log(`Valid records: ${this.validationResults.validRecords}`)
    console.log(`Corrected records: ${this.validationResults.correctedRecords}`)
    console.log(`Error records: ${this.validationResults.errorRecords}`)
    console.log(`Correction rate: ${((this.validationResults.correctedRecords / this.validationResults.totalRecords) * 100).toFixed(2)}%`)
    
    if (this.validationResults.corrections.length > 0) {
      console.log(`\n--- DETAILED CORRECTIONS ---`)
      this.validationResults.corrections.forEach((correction, index) => {
        console.log(`${index + 1}. Employee ${correction.employeeUid} - ${correction.date}`)
        console.log(`   Record ID: ${correction.recordId} (${correction.clockType})`)
        console.log(`   Regular: ${correction.originalRegular} → ${correction.correctedRegular} (diff: ${correction.regularDiff.toFixed(4)})`)
        console.log(`   Overtime: ${correction.originalOvertime} → ${correction.correctedOvertime} (diff: ${correction.overtimeDiff.toFixed(4)})`)
      })
    }
    
    console.log(`=== END VALIDATION SUMMARY ===`)
  }

  /**
   * Get validation report as an object
   */
  getValidationReport() {
    return {
      summary: {
        totalRecords: this.validationResults.totalRecords,
        validRecords: this.validationResults.validRecords,
        correctedRecords: this.validationResults.correctedRecords,
        errorRecords: this.validationResults.errorRecords,
        correctionRate: (this.validationResults.correctedRecords / this.validationResults.totalRecords) * 100
      },
      corrections: this.validationResults.corrections,
      timestamp: new Date().toISOString()
    }
  }

  /**
   * Validate specific employee's attendance for today
   */
  async validateTodayAttendance(employeeUid, options = {}) {
    const today = new Date().toISOString().split('T')[0]
    return await this.validateAttendanceData(today, today, employeeUid, options)
  }

  /**
   * Validate all unsynced records
   */
  async validateUnsyncedRecords(options = {}) {
    console.log(`Validating unsynced records...`)
    
    const unsyncedRecords = this.db.prepare(`
      SELECT DISTINCT employee_uid, date
      FROM attendance 
      WHERE is_synced = 0
      ORDER BY employee_uid, date
    `).all()
    
    console.log(`Found ${unsyncedRecords.length} employee-date combinations with unsynced records`)
    
    for (const { employee_uid, date } of unsyncedRecords) {
      await this.validateAttendanceData(date, date, employee_uid, options)
    }
    
    return this.validationResults
  }
}

/**
 * Convenience functions for external use
 */

/**
 * Validate attendance data for a date range
 */
async function validateAttendanceData(startDate = null, endDate = null, employeeUid = null, options = {}) {
  const validator = new AttendanceValidationService()
  return await validator.validateAttendanceData(startDate, endDate, employeeUid, options)
}

/**
 * Validate today's attendance for all employees
 */
async function validateTodayAttendance(options = {}) {
  const today = new Date().toISOString().split('T')[0]
  return await validateAttendanceData(today, today, null, options)
}

/**
 * Validate a specific employee's attendance for today
 */
async function validateEmployeeTodayAttendance(employeeUid, options = {}) {
  const validator = new AttendanceValidationService()
  return await validator.validateTodayAttendance(employeeUid, options)
}

/**
 * Validate all unsynced records and correct them
 */
async function validateAndCorrectUnsyncedRecords(options = {}) {
  const validator = new AttendanceValidationService()
  return await validator.validateUnsyncedRecords({
    autoCorrect: true,
    updateSyncStatus: true,
    ...options
  })
}

/**
 * Quick validation of a specific attendance record
 */
async function validateSingleRecord(recordId, options = {}) {
  const db = getDatabase()
  
  try {
    // Get the record
    const record = db.prepare(`
      SELECT * FROM attendance WHERE id = ?
    `).get(recordId)
    
    if (!record) {
      throw new Error(`Record ${recordId} not found`)
    }
    
    if (!record.clock_type.endsWith('_out')) {
      console.log(`Record ${recordId} is not a clock-out record, skipping validation`)
      return { valid: true, message: 'Not a clock-out record' }
    }
    
    // Get all records for this employee on this date
    const allRecords = db.prepare(`
      SELECT * FROM attendance 
      WHERE employee_uid = ? AND date = ?
      ORDER BY clock_time
    `).all(record.employee_uid, record.date)
    
    const validator = new AttendanceValidationService(db)
    const isValid = await validator.validateClockOutRecord(record, allRecords, options)
    
    return {
      valid: isValid,
      corrections: validator.validationResults.corrections,
      message: isValid ? 'Record is valid' : 'Record was corrected'
    }
    
  } catch (error) {
    console.error(`Error validating single record ${recordId}:`, error)
    throw error
  }
}



module.exports = {
  AttendanceValidationService,
  validateAttendanceData,
  validateTodayAttendance,
  validateEmployeeTodayAttendance,
  validateAndCorrectUnsyncedRecords,
  validateSingleRecord
}