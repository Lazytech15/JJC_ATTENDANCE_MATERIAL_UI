const Attendance = require("../../database/models/attendance")
const Employee = require("../../database/models/employee")
const { 
  determineClockType, 
  getPendingClockOut, 
  getTodaysCompletedSessions,
  calculateHoursWithStats,  // Use the enhanced version with stats
  getEmployeeStatistics     // New function for detailed reporting
} = require("../../services/timeCalculator")
const { getDatabase } = require("../../database/setup")
const { broadcastUpdate } = require("../../services/websocket")
const profileService = require("../../services/profileService")
const dateService = require("../../services/dateService")
const settingsRoutes = require("./settings")

// Fix the determineClockType call in the clockAttendance function
async function clockAttendance(event, { input, inputType = "barcode" }) {
  try {
    // Find employee by barcode or ID number
    let employee
    if (inputType === "barcode") {
      employee = Employee.findByBarcode(input)
    } else {
      employee = Employee.findByIdNumber(input)
    }

    if (!employee) {
      return {
        success: false,
        error: "Employee not found",
        input: input,
        inputType: inputType,
      }
    }

    const today = dateService.getCurrentDate()
    const currentDateTime = new Date(dateService.getCurrentDateTime())
    const db = getDatabase()

    console.log(`=== CLOCKING ATTENDANCE FOR EMPLOYEE ${employee.uid} ===`)
    console.log(`Employee: ${employee.first_name} ${employee.last_name}`)
    console.log(`Current time: ${currentDateTime.toISOString()}`)

    // Check for any pending clock-out first
    const pendingClockOut = getPendingClockOut(employee.uid, db)
    
    if (pendingClockOut) {
      console.log(`Found pending clock: ${pendingClockOut.clockType} from ${pendingClockOut.clockTime}`)
      
      // Calculate hours for the pending session WITH STATISTICS
      const clockType = pendingClockOut.expectedClockOut
      console.log(`Processing clock-out: ${clockType}`)
      console.log(`Clock-in time for calculation: ${pendingClockOut.clockTime}`)
      console.log(`Clock-out time for calculation: ${currentDateTime}`)

      // Record the clock-out first to get the attendance ID and clock_out ID
      const attendanceRecord = await Attendance.clockIn(
        employee, 
        clockType, 
        profileService, 
        await getServerUrl(),
        pendingClockOut.clockTime
      )

      // ENHANCED: Use calculateHoursWithStats instead of regular calculateHours
      const hoursResult = calculateHoursWithStats(
        clockType, 
        currentDateTime, 
        pendingClockOut.clockTime,
        employee.uid,           // Pass employee UID for statistics
        pendingClockOut.id,     // Pass attendance ID for statistics
        attendanceRecord.id,    // Pass clock-out ID for statistics
        db                      // Pass database connection
      )
      
      console.log(`Hours calculation result with statistics:`, hoursResult)

      // Update the hours if they weren't calculated correctly in the database layer
      if ((attendanceRecord.regular_hours === 0 && attendanceRecord.overtime_hours === 0) && 
          (hoursResult.regularHours > 0 || hoursResult.overtimeHours > 0)) {
        console.log(`Updating attendance record with calculated hours...`)
        
        try {
          const updateQuery = db.prepare(`
            UPDATE attendance 
            SET regular_hours = ?, overtime_hours = ?
            WHERE id = ?
          `)
          updateQuery.run(hoursResult.regularHours, hoursResult.overtimeHours, attendanceRecord.id)
          
          attendanceRecord.regular_hours = hoursResult.regularHours
          attendanceRecord.overtime_hours = hoursResult.overtimeHours
          
          console.log(`✓ Updated attendance record with Regular=${hoursResult.regularHours}, Overtime=${hoursResult.overtimeHours}`)
          console.log(`✓ Statistics automatically saved to attendance_statistics table`)
        } catch (updateError) {
          console.error('Error updating attendance record with hours:', updateError)
        }
      }

      // Broadcast clock-out message with enhanced statistics
      broadcastUpdate("attendance_update", {
        type: "clock_out",
        sessionType: getSessionType(clockType),
        employee: employee,
        clockType: clockType,
        time: currentDateTime.toISOString(),
        regularHours: attendanceRecord.regular_hours,
        overtimeHours: attendanceRecord.overtime_hours,
        attendanceRecord: attendanceRecord,
        isPendingResolution: true,
        originalClockIn: {
          type: pendingClockOut.clockType,
          time: pendingClockOut.clockTime.toISOString()
        },
        // ENHANCED: Include statistics flag for UI notifications
        hasDetailedStats: true
      })

      return {
        success: true,
        data: {
          employee: attendanceRecord.employee,
          clockType: clockType,
          sessionType: getSessionType(clockType),
          clockTime: attendanceRecord.clock_time,
          regularHours: attendanceRecord.regular_hours,
          overtimeHours: attendanceRecord.overtime_hours,
          isOvertimeSession: isOvertimeSession(clockType),
          resolvedPendingClock: true,
          originalClockIn: {
            type: pendingClockOut.clockType,
            time: pendingClockOut.clockTime.toISOString()
          },
          // ENHANCED: Flag that detailed statistics are available
          statisticsRecorded: true
        },
      }
    }

    // Get last clock type to determine next action
    const getLastClockTypeQuery = db.prepare(`
      SELECT clock_type, clock_time 
      FROM attendance 
      WHERE employee_uid = ? 
        AND date = ?
      ORDER BY clock_time DESC 
      LIMIT 1
    `)

    const lastClockRecord = getLastClockTypeQuery.get(employee.uid, today)
    const lastClockType = lastClockRecord ? lastClockRecord.clock_type : null
    const lastClockTime = lastClockRecord ? new Date(lastClockRecord.clock_time) : null

    console.log(`Last clock record: ${lastClockType} at ${lastClockTime}`)

    // FIXED: Pass all required parameters to determineClockType
    const clockType = determineClockType(
      lastClockType, 
      currentDateTime, 
      lastClockTime, 
      employee.uid,  // Pass employee UID for the new 17:00 rule
      db             // Pass database connection for the new 17:00 rule
    )
    console.log(`Determined clock type: ${clockType}`)

    // ENHANCED: Better validation for clock-out scenarios
    if (isValidClockOut(clockType)) {
      // Double-check that we don't have a pending clock-in that wasn't found
      const doubleCheckPendingQuery = db.prepare(`
        SELECT 
          id, clock_type, clock_time, date
        FROM attendance 
        WHERE employee_uid = ? 
          AND clock_type LIKE '%_in'
          AND date = ?
          AND NOT EXISTS (
            SELECT 1 FROM attendance a2
            WHERE a2.employee_uid = ? 
              AND a2.clock_type = REPLACE(attendance.clock_type, '_in', '_out')
              AND a2.clock_time > attendance.clock_time
              AND a2.date = attendance.date
          )
        ORDER BY clock_time DESC 
        LIMIT 1
      `)
      
      const missedPendingClock = doubleCheckPendingQuery.get(employee.uid, today, employee.uid)
      
      if (missedPendingClock) {
        console.log(`Found missed pending clock-in: ${missedPendingClock.clock_type} at ${missedPendingClock.clock_time}`)
        
        // Create the expected clock-out data
        const expectedClockOut = {
          id: missedPendingClock.id,
          clockType: missedPendingClock.clock_type,
          clockTime: new Date(missedPendingClock.clock_time),
          date: missedPendingClock.date,
          expectedClockOut: missedPendingClock.clock_type.replace('_in', '_out')
        }
        
        // Process this as a pending clock-out resolution
        const attendanceRecord = await Attendance.clockIn(
          employee, 
          expectedClockOut.expectedClockOut, 
          profileService, 
          await getServerUrl(),
          expectedClockOut.clockTime
        )

        const hoursResult = calculateHoursWithStats(
          expectedClockOut.expectedClockOut, 
          currentDateTime, 
          expectedClockOut.clockTime,
          employee.uid,
          expectedClockOut.id,
          attendanceRecord.id,
          db
        )
        
        // Update hours in database
        if ((attendanceRecord.regular_hours === 0 && attendanceRecord.overtime_hours === 0) && 
            (hoursResult.regularHours > 0 || hoursResult.overtimeHours > 0)) {
          const updateQuery = db.prepare(`
            UPDATE attendance 
            SET regular_hours = ?, overtime_hours = ?
            WHERE id = ?
          `)
          updateQuery.run(hoursResult.regularHours, hoursResult.overtimeHours, attendanceRecord.id)
          
          attendanceRecord.regular_hours = hoursResult.regularHours
          attendanceRecord.overtime_hours = hoursResult.overtimeHours
        }

        // Broadcast successful resolution
        broadcastUpdate("attendance_update", {
          type: "clock_out",
          sessionType: getSessionType(expectedClockOut.expectedClockOut),
          employee: employee,
          clockType: expectedClockOut.expectedClockOut,
          time: currentDateTime.toISOString(),
          regularHours: attendanceRecord.regular_hours,
          overtimeHours: attendanceRecord.overtime_hours,
          attendanceRecord: attendanceRecord,
          isPendingResolution: true,
          originalClockIn: {
            type: expectedClockOut.clockType,
            time: expectedClockOut.clockTime.toISOString()
          },
          hasDetailedStats: true,
          wasRecoveredSession: true
        })

        return {
          success: true,
          data: {
            employee: attendanceRecord.employee,
            clockType: expectedClockOut.expectedClockOut,
            sessionType: getSessionType(expectedClockOut.expectedClockOut),
            clockTime: attendanceRecord.clock_time,
            regularHours: attendanceRecord.regular_hours,
            overtimeHours: attendanceRecord.overtime_hours,
            isOvertimeSession: isOvertimeSession(expectedClockOut.expectedClockOut),
            resolvedPendingClock: true,
            wasRecoveredSession: true,
            originalClockIn: {
              type: expectedClockOut.clockType,
              time: expectedClockOut.clockTime.toISOString()
            },
            statisticsRecorded: true
          },
        }
      }
      
      // If we still get here, it means there's truly no pending clock-in
      console.error(`Unexpected clock-out type without pending clock-in: ${clockType}`)
      console.error(`Last clock type: ${lastClockType}`)
      console.error(`Current time: ${currentDateTime.toISOString()}`)
      
      // Provide more helpful error message based on the situation
      let errorMessage = "Cannot clock out without an active session. "
      
      if (lastClockType && lastClockType.endsWith('_out')) {
        errorMessage += `Your last action was clocking out (${getSessionType(lastClockType)}). Please clock in first.`
      } else if (!lastClockType) {
        errorMessage += "No previous clock records found for today. Please clock in first."
      } else {
        errorMessage += `Last recorded action: ${getSessionType(lastClockType)}. Please contact administrator if this seems incorrect.`
      }
      
      return {
        success: false,
        error: errorMessage,
        input: input,
        inputType: inputType,
        debugInfo: {
          determinedClockType: clockType,
          lastClockType: lastClockType,
          lastClockTime: lastClockTime?.toISOString(),
          currentTime: currentDateTime.toISOString()
        }
      }
    }

    // Process normal clock-in
    const completedSessions = getTodaysCompletedSessions(employee.uid, today, db)
    const attendanceRecord = await Attendance.clockIn(employee, clockType, profileService, await getServerUrl())

    console.log(`Successfully clocked in with type: ${clockType}`)

    broadcastUpdate("attendance_update", {
      type: "clock_in",
      sessionType: getSessionType(clockType),
      employee: employee,
      clockType: clockType,
      time: currentDateTime.toISOString(),
      regularHours: 0,
      overtimeHours: 0,
      attendanceRecord: attendanceRecord,
      todaysCompletedSessions: completedSessions.length
    })

    return {
      success: true,
      data: {
        employee: attendanceRecord.employee,
        clockType: clockType,
        sessionType: getSessionType(clockType),
        clockTime: attendanceRecord.clock_time,
        regularHours: 0,
        overtimeHours: 0,
        isOvertimeSession: isOvertimeSession(clockType),
        isNewClockIn: true,
        todaysCompletedSessions: completedSessions.length
      },
    }

  } catch (error) {
    console.error("Error clocking attendance:", error)
    return { 
      success: false, 
      error: error.message,
      stack: error.stack // Include stack trace for debugging
    }
  }
}

// ENHANCED: New function to get detailed employee statistics for reporting
async function getEmployeeDetailedStatistics(event, { employeeUid, date = null }) {
  try {
    const db = getDatabase()
    const targetDate = date || dateService.getCurrentDate()
    
    console.log(`Getting detailed statistics for employee ${employeeUid} on ${targetDate}`)
    
    // Use the enhanced statistics function from timeCalculator
    const statistics = getEmployeeStatistics(employeeUid, targetDate, db)
    
    if (!statistics) {
      return {
        success: false,
        error: "No statistics found for the specified employee and date"
      }
    }

    // Get basic attendance records for comparison
    const basicAttendance = Attendance.getEmployeeAttendance(employeeUid, targetDate, targetDate)
    
    return {
      success: true,
      data: {
        basicAttendance: basicAttendance,
        detailedStatistics: statistics,
        comparisonData: {
          basicTotalHours: basicAttendance.reduce((sum, record) => 
            sum + (record.regular_hours || 0) + (record.overtime_hours || 0), 0),
          statisticsTotalHours: statistics.dailyTotals.totalHours,
          sessionsCount: statistics.sessionsCount,
          hasDiscrepancy: Math.abs(
            basicAttendance.reduce((sum, record) => sum + (record.regular_hours || 0) + (record.overtime_hours || 0), 0) - 
            statistics.dailyTotals.totalHours
          ) > 0.01 // Allow for small floating point differences
        }
      }
    }
    
  } catch (error) {
    console.error("Error getting detailed employee statistics:", error)
    return { success: false, error: error.message }
  }
}

// ENHANCED: New function to generate comprehensive attendance reports with statistics
async function generateAttendanceReport(event, { startDate, endDate, includeStatistics = true, employeeUids = [] }) {
  try {
    const db = getDatabase()
    
    console.log(`Generating attendance report from ${startDate} to ${endDate}`)
    console.log(`Include statistics: ${includeStatistics}`)
    console.log(`Employee UIDs filter: ${employeeUids.length > 0 ? employeeUids.join(', ') : 'All employees'}`)
    
    // Get basic attendance data
    let attendance = Attendance.getAttendanceByDateRange(startDate, endDate)
    
    // Filter by employee UIDs if specified
    if (employeeUids.length > 0) {
      attendance = attendance.filter(record => employeeUids.includes(record.employee_uid))
    }
    
    // Enhance attendance data with session information
    const enhancedAttendance = attendance.map(record => ({
      ...record,
      sessionType: getSessionType(record.clock_type),
      isOvertimeSession: isOvertimeSession(record.clock_type),
      totalHours: (record.regular_hours || 0) + (record.overtime_hours || 0),
    }))

    let reportData = {
      dateRange: { startDate, endDate },
      totalRecords: enhancedAttendance.length,
      attendance: enhancedAttendance,
      summary: {
        totalRegularHours: enhancedAttendance.reduce((sum, record) => sum + (record.regular_hours || 0), 0),
        totalOvertimeHours: enhancedAttendance.reduce((sum, record) => sum + (record.overtime_hours || 0), 0),
        uniqueEmployees: new Set(enhancedAttendance.map(record => record.employee_uid)).size,
        uniqueDates: new Set(enhancedAttendance.map(record => record.date)).size,
        sessionBreakdown: {
          morning: enhancedAttendance.filter(record => record.clock_type?.startsWith("morning")).length,
          afternoon: enhancedAttendance.filter(record => record.clock_type?.startsWith("afternoon")).length,
          evening: enhancedAttendance.filter(record => record.clock_type?.startsWith("evening")).length,
          overtime: enhancedAttendance.filter(record => record.clock_type?.startsWith("overtime")).length,
        }
      }
    }

    // Add detailed statistics if requested
    if (includeStatistics) {
      console.log('Including detailed statistics in report...')
      
      // Get all unique employee-date combinations that have statistics
      const statsQuery = db.prepare(`
        SELECT DISTINCT employee_uid, date, COUNT(*) as session_count
        FROM attendance_statistics 
        WHERE date BETWEEN ? AND ?
        ${employeeUids.length > 0 ? `AND employee_uid IN (${employeeUids.map(() => '?').join(',')})` : ''}
        GROUP BY employee_uid, date
        ORDER BY employee_uid, date
      `)
      
      const params = [startDate, endDate, ...employeeUids]
      const statisticsAvailable = statsQuery.all(...params)
      
      console.log(`Found statistics for ${statisticsAvailable.length} employee-date combinations`)
      
      // Get detailed statistics for each combination
      const detailedStatistics = []
      for (const statRecord of statisticsAvailable) {
        const empStats = getEmployeeStatistics(statRecord.employee_uid, statRecord.date, db)
        if (empStats) {
          detailedStatistics.push(empStats)
        }
      }
      
      reportData.statisticsData = {
        available: statisticsAvailable.length > 0,
        employeeDateCombinations: statisticsAvailable.length,
        totalStatisticsRecords: statisticsAvailable.reduce((sum, record) => sum + record.session_count, 0),
        detailedStatistics: detailedStatistics,
        aggregatedStatistics: calculateAggregatedStatistics(detailedStatistics)
      }
    }

    return {
      success: true,
      data: reportData
    }
    
  } catch (error) {
    console.error("Error generating attendance report:", error)
    return { success: false, error: error.message }
  }
}

// Helper function to calculate aggregated statistics across multiple employees/dates
function calculateAggregatedStatistics(detailedStatistics) {
  if (detailedStatistics.length === 0) {
    return null
  }

  const aggregated = {
    totalEmployees: new Set(detailedStatistics.map(stat => stat.employee.uid)).size,
    totalDates: new Set(detailedStatistics.map(stat => stat.date)).size,
    totalSessions: detailedStatistics.reduce((sum, stat) => sum + stat.dailyTotals.sessionsCount, 0),
    totalRegularHours: detailedStatistics.reduce((sum, stat) => sum + stat.dailyTotals.totalRegularHours, 0),
    totalOvertimeHours: detailedStatistics.reduce((sum, stat) => sum + stat.dailyTotals.totalOvertimeHours, 0),
    specialRules: {
      earlyMorningRuleApplications: 0,
      overnightShifts: 0,
      gracePeriodApplications: 0
    },
    sessionTypeBreakdown: {
      morning: 0,
      afternoon: 0,
      evening: 0,
      overtime: 0
    }
  }

  // Count special rule applications and session types
  detailedStatistics.forEach(empStat => {
    empStat.sessions.forEach(session => {
      if (session.early_morning_rule_applied) aggregated.specialRules.earlyMorningRuleApplications++
      if (session.overnight_shift) aggregated.specialRules.overnightShifts++
      if (session.grace_period_applied) aggregated.specialRules.gracePeriodApplications++
      
      // Count session types
      if (session.session_type === 'morning') aggregated.sessionTypeBreakdown.morning++
      else if (session.session_type === 'afternoon') aggregated.sessionTypeBreakdown.afternoon++
      else if (session.session_type === 'evening') aggregated.sessionTypeBreakdown.evening++
      else if (session.session_type === 'overtime') aggregated.sessionTypeBreakdown.overtime++
    })
  })

  aggregated.totalHours = aggregated.totalRegularHours + aggregated.totalOvertimeHours

  return aggregated
}

// ENHANCED: Updated function to include statistics information
async function getTodayAttendance() {
  try {
    const attendance = Attendance.getTodayAttendance()
    const currentlyClocked = Attendance.getCurrentlyClocked()
    const stats = Attendance.getTodayStatistics()
    const db = getDatabase()

    // Check how many attendance records have corresponding statistics
    const today = dateService.getCurrentDate()
    const statsCountQuery = db.prepare(`
      SELECT COUNT(DISTINCT employee_uid) as employees_with_stats,
             COUNT(*) as total_stat_records
      FROM attendance_statistics 
      WHERE date = ?
    `)
    const statsCount = statsCountQuery.get(today)

    const enhancedCurrentlyClocked = await Promise.all(
      currentlyClocked.map(async (record) => {
        const pendingClockOut = getPendingClockOut(record.uid, db)
        
        return {
          ...record,
          sessionType: getSessionType(record.last_clock_type),
          isOvertimeSession: isOvertimeSession(record.last_clock_type),
          clock_type: record.last_clock_type,
          hasPendingClockOut: !!pendingClockOut,
          expectedClockOut: pendingClockOut?.expectedClockOut || null
        }
      })
    )

    const enhancedAttendance = attendance.map(record => ({
      ...record,
      sessionType: getSessionType(record.clock_type),
      isOvertimeSession: isOvertimeSession(record.clock_type),
    }))

    return {
      success: true,
      data: {
        attendance: enhancedAttendance,
        currentlyClocked: enhancedCurrentlyClocked,
        statistics: {
          ...stats,
          overtimeEmployees: enhancedCurrentlyClocked.filter(record => 
            isOvertimeSession(record.last_clock_type)
          ).length,
          eveningSessionEmployees: enhancedCurrentlyClocked.filter(record => 
            record.last_clock_type?.startsWith("evening")
          ).length,
          pendingClockOuts: enhancedCurrentlyClocked.filter(record =>
            record.hasPendingClockOut
          ).length,
          // ENHANCED: Add statistics tracking info
          statisticsData: {
            employeesWithDetailedStats: statsCount.employees_with_stats || 0,
            totalDetailedStatRecords: statsCount.total_stat_records || 0,
            statisticsAvailable: (statsCount.total_stat_records || 0) > 0
          }
        },
      },
    }
  } catch (error) {
    console.error("Error getting today attendance:", error)
    return { success: false, error: error.message }
  }
}

// Keep existing helper functions
async function getServerUrl() {
  try {
    const settingsResult = await settingsRoutes.getSettings()
    return settingsResult.success ? settingsResult.data.serverUrl : "http://localhost:3000"
  } catch (error) {
    console.error("Error getting server URL:", error)
    return "http://localhost:3000"
  }
}

function isClockIn(clockType) {
  return clockType.endsWith("_in")
}

function isValidClockOut(clockType) {
  return clockType.endsWith("_out")
}

function getSessionType(clockType) {
  if (clockType.startsWith("morning")) return "Morning"
  if (clockType.startsWith("afternoon")) return "Afternoon"
  if (clockType.startsWith("evening")) return "Evening (Overtime)"
  if (clockType.startsWith("overtime")) return "Overtime"
  return "Unknown"
}

function isOvertimeSession(clockType) {
  return clockType.startsWith("evening") || clockType.startsWith("overtime")
}

// Keep existing functions...
async function getEmployeeStatus(employeeUid) {
  try {
    const db = getDatabase()
    const today = dateService.getCurrentDate()
    
    const pendingClockOut = getPendingClockOut(employeeUid, db)
    const completedSessions = getTodaysCompletedSessions(employeeUid, today, db)
    
    const dailyTotals = completedSessions.reduce(
      (totals, session) => ({
        regularHours: totals.regularHours + session.regularHours,
        overtimeHours: totals.overtimeHours + session.overtimeHours
      }), 
      { regularHours: 0, overtimeHours: 0 }
    )

    return {
      success: true,
      data: {
        employeeUid,
        hasPendingClockOut: !!pendingClockOut,
        pendingSession: pendingClockOut ? {
          type: pendingClockOut.clockType,
          expectedClockOut: pendingClockOut.expectedClockOut,
          clockInTime: pendingClockOut.clockTime.toISOString(),
          sessionType: getSessionType(pendingClockOut.clockType)
        } : null,
        todaysCompletedSessions: completedSessions.length,
        dailyTotals: {
          ...dailyTotals,
          totalHours: dailyTotals.regularHours + dailyTotals.overtimeHours
        },
        completedSessions: completedSessions.map(session => ({
          type: session.clockType,
          sessionType: getSessionType(session.clockType),
          clockTime: session.clockTime.toISOString(),
          regularHours: session.regularHours,
          overtimeHours: session.overtimeHours
        }))
      }
    }
  } catch (error) {
    console.error("Error getting employee status:", error)
    return { success: false, error: error.message }
  }
}

// Keep other existing functions unchanged...
async function getEmployeeAttendance(event, { employeeUid, startDate, endDate }) {
  try {
    const attendance = Attendance.getEmployeeAttendance(employeeUid, startDate, endDate)
    
    const enhancedAttendance = attendance.map(record => ({
      ...record,
      sessionType: getSessionType(record.clock_type),
      isOvertimeSession: isOvertimeSession(record.clock_type),
      totalHours: (record.regular_hours || 0) + (record.overtime_hours || 0),
    }))

    const summary = {
      totalRegularHours: enhancedAttendance.reduce((sum, record) => sum + (record.regular_hours || 0), 0),
      totalOvertimeHours: enhancedAttendance.reduce((sum, record) => sum + (record.overtime_hours || 0), 0),
      totalDays: enhancedAttendance.length > 0 ? new Set(enhancedAttendance.map(record => record.date)).size : 0,
      eveningSessions: enhancedAttendance.filter(record => record.clock_type?.startsWith("evening")).length,
      overtimeSessions: enhancedAttendance.filter(record => isOvertimeSession(record.clock_type)).length,
    }

    summary.totalHours = summary.totalRegularHours + summary.totalOvertimeHours

    const currentStatus = await getEmployeeStatus(employeeUid)

    return { 
      success: true, 
      data: {
        attendance: enhancedAttendance,
        summary: summary,
        currentStatus: currentStatus.success ? currentStatus.data : null
      }
    }
  } catch (error) {
    console.error("Error getting employee attendance:", error)
    return { success: false, error: error.message }
  }
}

async function getTodayStatistics() {
  try {
    const stats = Attendance.getTodayStatistics()
    const currentlyClocked = Attendance.getCurrentlyClocked()
    const db = getDatabase()
    
    const pendingClockOuts = await Promise.all(
      currentlyClocked.map(async (record) => {
        const pending = getPendingClockOut(record.uid, db)
        return pending ? { ...record, pending } : null
      })
    )
    
    const validPendingClockOuts = pendingClockOuts.filter(Boolean)
    
    const enhancedStats = {
      ...stats,
      currentOvertimeEmployees: currentlyClocked.filter(record => 
        isOvertimeSession(record.last_clock_type)
      ).length,
      currentEveningEmployees: currentlyClocked.filter(record => 
        record.last_clock_type?.startsWith("evening")
      ).length,
      pendingClockOuts: validPendingClockOuts.length,
      sessionBreakdown: {
        morning: currentlyClocked.filter(record => record.last_clock_type?.startsWith("morning")).length,
        afternoon: currentlyClocked.filter(record => record.last_clock_type?.startsWith("afternoon")).length,
        evening: currentlyClocked.filter(record => record.last_clock_type?.startsWith("evening")).length,
        overtime: currentlyClocked.filter(record => record.last_clock_type?.startsWith("overtime")).length,
      }
    }

    return {
      success: true,
      data: enhancedStats,
    }
  } catch (error) {
    console.error("Error getting today statistics:", error)
    return { success: false, error: error.message }
  }
}

async function getOvertimeSummary(event, { startDate, endDate }) {
  try {
    const attendance = Attendance.getAttendanceByDateRange(startDate, endDate)
    
    const overtimeData = attendance
      .filter(record => isOvertimeSession(record.clock_type))
      .map(record => ({
        ...record,
        sessionType: getSessionType(record.clock_type),
      }))

    const employeeOvertimeMap = overtimeData.reduce((map, record) => {
      const key = record.employee_uid
      if (!map[key]) {
        map[key] = {
          employee_uid: record.employee_uid,
          employee_name: `${record.first_name} ${record.last_name}`,
          sessions: [],
          totalOvertimeHours: 0
        }
      }
      map[key].sessions.push(record)
      map[key].totalOvertimeHours += record.overtime_hours || 0
      return map
    }, {})

    const employeeOvertimeData = Object.values(employeeOvertimeMap)

    const summary = {
      totalOvertimeHours: overtimeData.reduce((sum, record) => sum + (record.overtime_hours || 0), 0),
      totalOvertimeSessions: overtimeData.length,
      employeesWithOvertime: employeeOvertimeData.length,
      averageOvertimePerSession: overtimeData.length > 0 
        ? (overtimeData.reduce((sum, record) => sum + (record.overtime_hours || 0), 0) / overtimeData.length)
        : 0,
      averageOvertimePerEmployee: employeeOvertimeData.length > 0
        ? (employeeOvertimeData.reduce((sum, emp) => sum + emp.totalOvertimeHours, 0) / employeeOvertimeData.length)
        : 0,
      sessionTypeBreakdown: {
        evening: overtimeData.filter(record => record.clock_type.startsWith("evening")).length,
        overtime: overtimeData.filter(record => record.clock_type.startsWith("overtime")).length,
      }
    }

    return {
      success: true,
      data: {
        overtimeRecords: overtimeData,
        employeeBreakdown: employeeOvertimeData,
        summary: summary,
      }
    }
  } catch (error) {
    console.error("Error getting overtime summary:", error)
    return { success: false, error: error.message }
  }
}

module.exports = {
  clockAttendance,
  getTodayAttendance,
  getEmployeeAttendance,
  getTodayStatistics,
  getOvertimeSummary,
  getEmployeeStatus,
  // ENHANCED: New functions for detailed statistics and reporting
  getEmployeeDetailedStatistics,
  generateAttendanceReport,
}