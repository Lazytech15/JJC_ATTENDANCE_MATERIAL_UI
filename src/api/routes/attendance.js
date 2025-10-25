const Attendance = require("../../database/models/attendancedb")
const Employee = require("../../database/models/employee")
const { 
  determineClockType, 
  getPendingClockOut, 
  getTodaysCompletedSessions,
  calculateHoursWithStats,
  getEmployeeStatistics
} = require("../../services/timeCalculator")
const { 
  getDatabase,
  updateDailyAttendanceSummary,
  getDailyAttendanceSummary,
  rebuildDailyAttendanceSummary
} = require("../../database/setup")
const { broadcastUpdate } = require("../../services/websocket")
const profileService = require("../../services/profileService")
const dateService = require("../../services/dateService")

// Enhanced clockAttendance function with daily summary updates and duplicate prevention
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
    console.log(`Current date: ${today}`)

    // DUPLICATE PREVENTION: Check for recent scans within 5 seconds
    const duplicateCheckQuery = db.prepare(`
      SELECT id, clock_type, clock_time
      FROM attendance 
      WHERE employee_uid = ? 
        AND date = ?
        AND ABS((julianday(?) - julianday(clock_time)) * 86400) < 5
      ORDER BY clock_time DESC 
      LIMIT 1
    `)
    
    const recentDuplicate = duplicateCheckQuery.get(
      employee.uid, 
      today,
      currentDateTime.toISOString()
    )
    
    if (recentDuplicate) {
      console.log(`⚠️ DUPLICATE SCAN DETECTED - Ignoring duplicate entry`)
      console.log(`Recent scan: ${recentDuplicate.clock_type} at ${recentDuplicate.clock_time}`)
      
      return {
        success: false,
        error: "Duplicate scan detected. Please wait a few seconds before scanning again.",
        isDuplicate: true,
        recentScan: {
          clockType: recentDuplicate.clock_type,
          clockTime: recentDuplicate.clock_time,
          sessionType: getSessionType(recentDuplicate.clock_type)
        },
        input: input,
        inputType: inputType,
      }
    }

    // FIXED: Check for any pending clock-out from the SAME DAY only
    const pendingClockOut = getPendingClockOut(employee.uid, today, db)
    
    if (pendingClockOut) {
      console.log(`Found pending clock from SAME DAY: ${pendingClockOut.clockType} from ${pendingClockOut.clockTime}`)
      
      // Calculate hours for the pending session WITH STATISTICS
      const clockType = pendingClockOut.expectedClockOut
      console.log(`Processing clock-out: ${clockType}`)

      // Record the clock-out first to get the attendance ID and clock_out ID
      const attendanceRecord = await Attendance.clockIn(
        employee, 
        clockType, 
        profileService.ensureProfilesDirectory(),
        pendingClockOut.clockTime,
        input
      )

      // Use calculateHoursWithStats for enhanced calculation
      const hoursResult = calculateHoursWithStats(
        clockType, 
        currentDateTime, 
        pendingClockOut.clockTime,
        employee.uid,
        pendingClockOut.id,
        attendanceRecord.id,
        db,
        input
      )
      
      console.log(`Hours calculation result with statistics:`, hoursResult)

      // Update the hours if they weren't calculated correctly
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
        
        console.log(`✓ Updated attendance record with Regular=${hoursResult.regularHours}, Overtime=${hoursResult.overtimeHours}`)
      }

      // ENHANCED: Update daily attendance summary after successful clock-out
      setTimeout(() => {
        updateDailyAttendanceSummary(employee.uid, today, db)
        // console.log(`✓ Daily attendance summary updated for employee ${employee.uid}`)
      }, 100)

      // Broadcast clock-out message
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
        hasDetailedStats: true,
        dailySummaryUpdated: true
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
          statisticsRecorded: true,
          dailySummaryUpdated: true
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

    console.log(`Last clock record for ${today}: ${lastClockType} at ${lastClockTime}`)

    // Determine next clock type
    const clockType = determineClockType(
      lastClockType, 
      currentDateTime, 
      lastClockTime, 
      employee.uid,
      db
    )
    console.log(`Determined clock type: ${clockType}`)

    // Handle clock-out validation
    if (isValidClockOut(clockType)) {
      // FIXED: Double-check for missed pending clock-ins from SAME DAY only
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
              AND a2.date = ?
          )
        ORDER BY clock_time DESC 
        LIMIT 1
      `)
      
      const missedPendingClock = doubleCheckPendingQuery.get(employee.uid, today, employee.uid, today)
      
      if (missedPendingClock) {
        console.log(`Found missed pending clock-in from SAME DAY: ${missedPendingClock.clock_type} at ${missedPendingClock.clock_time}`)
        
        // Process the missed clock-out
        const expectedClockOut = {
          id: missedPendingClock.id,
          clockType: missedPendingClock.clock_type,
          clockTime: new Date(missedPendingClock.clock_time),
          date: missedPendingClock.date,
          expectedClockOut: missedPendingClock.clock_type.replace('_in', '_out')
        }
        
        const attendanceRecord = await Attendance.clockIn(
          employee, 
          expectedClockOut.expectedClockOut, 
          profileService.ensureProfilesDirectory,
          expectedClockOut.clockTime,
          input
        )

        const hoursResult = calculateHoursWithStats(
          expectedClockOut.expectedClockOut, 
          currentDateTime, 
          expectedClockOut.clockTime,
          employee.uid,
          expectedClockOut.id,
          attendanceRecord.id,
          db,
          input
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

        // ENHANCED: Update daily attendance summary
        setTimeout(() => {
          updateDailyAttendanceSummary(employee.uid, today, db)
        }, 100)

        // Broadcast successful recovery
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
          wasRecoveredSession: true,
          dailySummaryUpdated: true
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
            statisticsRecorded: true,
            dailySummaryUpdated: true
          },
        }
      }
      
      // Error case: invalid clock-out without pending session
      let errorMessage = "Cannot clock out without an active session from today. "
      
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
          currentTime: currentDateTime.toISOString(),
          currentDate: today
        }
      }
    }

    // Process normal clock-in
    const completedSessions = getTodaysCompletedSessions(employee.uid, today, db)
    const attendanceRecord = await Attendance.clockIn(employee, clockType, profileService.ensureProfilesDirectory(), null, input)

    console.log(`Successfully clocked in with type: ${clockType}`)

    // ENHANCED: Update daily attendance summary after clock-in
    setTimeout(() => {
      updateDailyAttendanceSummary(employee.uid, today, db)
    }, 100)

    broadcastUpdate("attendance_update", {
      type: "clock_in",
      sessionType: getSessionType(clockType),
      employee: employee,
      clockType: clockType,
      time: currentDateTime.toISOString(),
      regularHours: 0,
      overtimeHours: 0,
      attendanceRecord: attendanceRecord,
      todaysCompletedSessions: completedSessions.length,
      dailySummaryUpdated: true
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
        todaysCompletedSessions: completedSessions.length,
        dailySummaryUpdated: true
      },
    }

  } catch (error) {
    console.error("Error clocking attendance:", error)
    return { 
      success: false, 
      error: error.message,
      stack: error.stack
    }
  }
}

// ENHANCED: New function to get readable daily attendance summary
async function getDailyAttendanceSummaryData(event, { startDate = null, endDate = null, employeeUid = null, includeIncomplete = true }) {
  try {
    const today = dateService.getCurrentDate()
    const actualStartDate = startDate || today
    const actualEndDate = endDate || today
    
    console.log(`Getting daily attendance summary from ${actualStartDate} to ${actualEndDate}`)
    if (employeeUid) console.log(`Filtering by employee UID: ${employeeUid}`)
    
    const db = getDatabase()
    let summaryData = getDailyAttendanceSummary(actualStartDate, actualEndDate, employeeUid, db)
    
    // Filter incomplete records if requested
    if (!includeIncomplete) {
      summaryData = summaryData.filter(record => !record.is_incomplete)
    }
    
    // Calculate summary statistics
    const statistics = {
      totalRecords: summaryData.length,
      totalEmployees: new Set(summaryData.map(record => record.employee_uid)).size,
      totalRegularHours: summaryData.reduce((sum, record) => sum + (record.regular_hours || 0), 0),
      totalOvertimeHours: summaryData.reduce((sum, record) => sum + (record.overtime_hours || 0), 0),
      totalHours: summaryData.reduce((sum, record) => sum + (record.total_hours || 0), 0),
      incompleteRecords: summaryData.filter(record => record.is_incomplete).length,
      overtimeRecords: summaryData.filter(record => record.has_overtime).length,
      eveningSessionRecords: summaryData.filter(record => record.has_evening_session).length,
      lateEntryRecords: summaryData.filter(record => record.has_late_entry).length,
      averageHoursPerRecord: summaryData.length > 0 ? 
        (summaryData.reduce((sum, record) => sum + (record.total_hours || 0), 0) / summaryData.length) : 0,
      departmentBreakdown: {}
    }
    
    // Calculate department breakdown
    summaryData.forEach(record => {
      const dept = record.department || 'Unknown'
      if (!statistics.departmentBreakdown[dept]) {
        statistics.departmentBreakdown[dept] = {
          employeeCount: 0,
          totalHours: 0,
          overtimeHours: 0
        }
      }
      statistics.departmentBreakdown[dept].employeeCount++
      statistics.departmentBreakdown[dept].totalHours += record.total_hours || 0
      statistics.departmentBreakdown[dept].overtimeHours += record.overtime_hours || 0
    })
    
    return {
      success: true,
      data: {
        summaryRecords: summaryData,
        statistics: statistics,
        dateRange: {
          startDate: actualStartDate,
          endDate: actualEndDate
        },
        filters: {
          employeeUid: employeeUid,
          includeIncomplete: includeIncomplete
        }
      }
    }
    
  } catch (error) {
    console.error("Error getting daily attendance summary:", error)
    return { success: false, error: error.message }
  }
}

// ENHANCED: New function to rebuild attendance summaries
async function rebuildAttendanceSummaries(event, { startDate, endDate }) {
  try {
    console.log(`Rebuilding attendance summaries from ${startDate} to ${endDate}`)
    
    const db = getDatabase()
    const result = rebuildDailyAttendanceSummary(startDate, endDate, db)
    
    // Broadcast update about the rebuild
    broadcastUpdate("system_update", {
      type: "summary_rebuild",
      startDate: startDate,
      endDate: endDate,
      result: result
    })
    
    return {
      success: true,
      data: {
        message: `Successfully rebuilt ${result.successCount} attendance summaries`,
        details: result,
        dateRange: { startDate, endDate }
      }
    }
    
  } catch (error) {
    console.error("Error rebuilding attendance summaries:", error)
    return { success: false, error: error.message }
  }
}

// ENHANCED: Function to get readable attendance data for specific employee
async function getEmployeeReadableAttendance(event, { employeeUid, startDate, endDate }) {
  try {
    const db = getDatabase()
    
    // Get basic attendance data
    const attendance = Attendance.getEmployeeAttendance(employeeUid, startDate, endDate)
    
    // Get daily summary data for the same period
    const summaryData = getDailyAttendanceSummary(startDate, endDate, employeeUid, db)
    
    // Get employee info
    const employee = Employee.findById(employeeUid)
    
    if (!employee) {
      return { success: false, error: "Employee not found" }
    }
    
    // Combine data for comprehensive view
    const enhancedAttendance = attendance.map(record => ({
      ...record,
      sessionType: getSessionType(record.clock_type),
      isOvertimeSession: isOvertimeSession(record.clock_type),
      totalHours: (record.regular_hours || 0) + (record.overtime_hours || 0),
    }))

    // Calculate summary
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
        employee: employee,
        attendance: enhancedAttendance,
        dailySummaries: summaryData,
        summary: summary,
        currentStatus: currentStatus.success ? currentStatus.data : null,
        readableData: {
          totalWorkingDays: summaryData.length,
          averageHoursPerDay: summaryData.length > 0 ? 
            (summaryData.reduce((sum, record) => sum + (record.total_hours || 0), 0) / summaryData.length) : 0,
          daysWithOvertime: summaryData.filter(record => record.has_overtime).length,
          incompleteDays: summaryData.filter(record => record.is_incomplete).length,
          lateDays: summaryData.filter(record => record.has_late_entry).length
        }
      }
    }
  } catch (error) {
    console.error("Error getting employee readable attendance:", error)
    return { success: false, error: error.message }
  }
}

// ENHANCED: Updated getTodayAttendance with daily summary information
async function getTodayAttendance() {
  try {
    const attendance = Attendance.getTodayAttendance()
    const currentlyClocked = Attendance.getCurrentlyClocked()
    const stats = Attendance.getTodayStatistics()
    const db = getDatabase()
    const today = dateService.getCurrentDate()

    // Get today's daily summaries
    const todaySummaries = getDailyAttendanceSummary(today, today, null, db)

    // Check statistics data
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
        dailySummaries: todaySummaries,
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
          statisticsData: {
            employeesWithDetailedStats: statsCount.employees_with_stats || 0,
            totalDetailedStatRecords: statsCount.total_stat_records || 0,
            statisticsAvailable: (statsCount.total_stat_records || 0) > 0
          },
          dailySummaryData: {
            totalSummaryRecords: todaySummaries.length,
            completedSummaries: todaySummaries.filter(record => !record.is_incomplete).length,
            incompleteSummaries: todaySummaries.filter(record => record.is_incomplete).length,
            overtimeSummaries: todaySummaries.filter(record => record.has_overtime).length,
            totalHoursFromSummaries: todaySummaries.reduce((sum, record) => sum + (record.total_hours || 0), 0)
          }
        },
      },
    }
  } catch (error) {
    console.error("Error getting today attendance:", error)
    return { success: false, error: error.message }
  }
}

// ENHANCED: New function to get attendance report with daily summaries
async function generateAttendanceReportWithSummaries(event, { startDate, endDate, includeStatistics = true, employeeUids = [], format = "detailed" }) {
  try {
    const db = getDatabase()
    
    console.log(`Generating attendance report with summaries from ${startDate} to ${endDate}`)
    console.log(`Format: ${format}, Include statistics: ${includeStatistics}`)
    
    // Get daily summaries (this is the main readable data)
    const summaryData = getDailyAttendanceSummary(startDate, endDate, null, db)
    
    // Filter by employee UIDs if specified
    let filteredSummaries = summaryData
    if (employeeUids.length > 0) {
      filteredSummaries = summaryData.filter(record => employeeUids.includes(record.employee_uid))
    }
    
    // Get basic attendance data for comparison if requested
    let attendance = []
    if (format === "detailed" || includeStatistics) {
      attendance = Attendance.getAttendanceByDateRange(startDate, endDate)
      if (employeeUids.length > 0) {
        attendance = attendance.filter(record => employeeUids.includes(record.employee_uid))
      }
    }

    // Calculate comprehensive statistics
    const summary = {
      dateRange: { startDate, endDate },
      totalSummaryRecords: filteredSummaries.length,
      uniqueEmployees: new Set(filteredSummaries.map(record => record.employee_uid)).size,
      uniqueDates: new Set(filteredSummaries.map(record => record.date)).size,
      totalRegularHours: filteredSummaries.reduce((sum, record) => sum + (record.regular_hours || 0), 0),
      totalOvertimeHours: filteredSummaries.reduce((sum, record) => sum + (record.overtime_hours || 0), 0),
      totalHours: filteredSummaries.reduce((sum, record) => sum + (record.total_hours || 0), 0),
      
      // Status breakdowns
      statusBreakdown: {
        completed: filteredSummaries.filter(record => !record.is_incomplete).length,
        incomplete: filteredSummaries.filter(record => record.is_incomplete).length,
        withOvertime: filteredSummaries.filter(record => record.has_overtime).length,
        withEveningSessions: filteredSummaries.filter(record => record.has_evening_session).length,
        withLateEntries: filteredSummaries.filter(record => record.has_late_entry).length,
      },
      
      // Department breakdown
      departmentStats: {},
      
      // Average calculations
      averageHoursPerDay: filteredSummaries.length > 0 ? 
        (filteredSummaries.reduce((sum, record) => sum + (record.total_hours || 0), 0) / filteredSummaries.length) : 0,
      averageRegularHoursPerDay: filteredSummaries.length > 0 ?
        (filteredSummaries.reduce((sum, record) => sum + (record.regular_hours || 0), 0) / filteredSummaries.length) : 0,
      averageOvertimeHoursPerDay: filteredSummaries.length > 0 ?
        (filteredSummaries.reduce((sum, record) => sum + (record.overtime_hours || 0), 0) / filteredSummaries.length) : 0,
    }
    
    // Calculate department statistics
    filteredSummaries.forEach(record => {
      const dept = record.department || 'Unknown'
      if (!summary.departmentStats[dept]) {
        summary.departmentStats[dept] = {
          employeeCount: new Set(),
          recordCount: 0,
          totalHours: 0,
          regularHours: 0,
          overtimeHours: 0,
          incompleteCount: 0,
          overtimeCount: 0
        }
      }
      
      const deptStats = summary.departmentStats[dept]
      deptStats.employeeCount.add(record.employee_uid)
      deptStats.recordCount++
      deptStats.totalHours += record.total_hours || 0
      deptStats.regularHours += record.regular_hours || 0
      deptStats.overtimeHours += record.overtime_hours || 0
      if (record.is_incomplete) deptStats.incompleteCount++
      if (record.has_overtime) deptStats.overtimeCount++
    })
    
    // Convert Sets to counts
    Object.keys(summary.departmentStats).forEach(dept => {
      summary.departmentStats[dept].employeeCount = summary.departmentStats[dept].employeeCount.size
    })

    let reportData = {
      summary: summary,
      readableSummaries: filteredSummaries,
      format: format,
      filters: { employeeUids, includeStatistics }
    }

    // Add detailed attendance data if requested
    if (format === "detailed") {
      const enhancedAttendance = attendance.map(record => ({
        ...record,
        sessionType: getSessionType(record.clock_type),
        isOvertimeSession: isOvertimeSession(record.clock_type),
        totalHours: (record.regular_hours || 0) + (record.overtime_hours || 0),
      }))
      
      reportData.detailedAttendance = enhancedAttendance
    }

    // Add statistics if requested
    if (includeStatistics) {
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
      
      reportData.statisticsData = {
        available: statisticsAvailable.length > 0,
        employeeDateCombinations: statisticsAvailable.length,
        totalStatisticsRecords: statisticsAvailable.reduce((sum, record) => sum + record.session_count, 0),
      }
    }

    return {
      success: true,
      data: reportData
    }
    
  } catch (error) {
    console.error("Error generating attendance report with summaries:", error)
    return { success: false, error: error.message }
  }
}

// Keep existing helper functions and other functions...
// async function getProfilesDirectory() {
//   try {
//     const settingsResult = await settingsRoutes.getSettings()
//     return settingsResult.success ? settingsResult.data.serverUrl : "http://localhost:3000"
//   } catch (error) {
//     console.error("Error getting server URL:", error)
//     return "http://localhost:3000"
//   }
// }

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

// Keep other existing functions...
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

async function getEmployeeAttendance(event, { employeeUid, startDate, endDate }) {
  try {
    return await getEmployeeReadableAttendance(event, { employeeUid, startDate, endDate })
  } catch (error) {
    console.error("Error getting employee attendance:", error)
    return { success: false, error: error.message }
  }
}

// Keep other existing functions unchanged...
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

// Enhanced function exports
async function getEmployeeDetailedStatistics(event, { employeeUid, date = null }) {
  try {
    const db = getDatabase()
    const targetDate = date || dateService.getCurrentDate()
    
    console.log(`Getting detailed statistics for employee ${employeeUid} on ${targetDate}`)
    
    const statistics = getEmployeeStatistics(employeeUid, targetDate, db)
    
    if (!statistics) {
      return {
        success: false,
        error: "No statistics found for the specified employee and date"
      }
    }

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
          ) > 0.01
        }
      }
    }
    
  } catch (error) {
    console.error("Error getting detailed employee statistics:", error)
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
  getEmployeeDetailedStatistics,
  
  // ENHANCED: New functions for daily summary functionality
  getDailyAttendanceSummaryData,
  rebuildAttendanceSummaries,
  getEmployeeReadableAttendance,
  generateAttendanceReportWithSummaries,
}