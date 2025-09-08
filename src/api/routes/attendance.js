const Attendance = require("../../database/models/attendance")
const Employee = require("../../database/models/employee")
const { determineClockType } = require("../../services/timeCalculator")
const { broadcastUpdate } = require("../../services/websocket")
const profileService = require("../../services/profileService")
const dateService = require("../../services/dateService")
const settingsRoutes = require("./settings")

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

    // Get the last clock record for this employee today
    const lastClock = Attendance.getLastClockForEmployee(employee.uid, today)
    
    // Determine the next clock type based on the last clock type
    const clockType = determineClockType(lastClock?.clock_type, currentDateTime)

    // Check for pending clock situations
    const hasPendingClockIn = Attendance.hasPendingClockIn(employee.uid, today)
    
    // Validate clock type sequence
    if (hasPendingClockIn && !isValidClockOut(clockType)) {
      return {
        success: false,
        error: "Invalid clock sequence. Please complete pending clock-in first.",
        input: input,
        inputType: inputType,
      }
    }

    const settingsResult = await settingsRoutes.getSettings()
    const serverUrl = settingsResult.success ? settingsResult.data.serverUrl : "http://localhost:3000"

    // Record attendance with profile service
    const attendanceRecord = await Attendance.clockIn(employee, clockType, profileService, serverUrl)

    // Broadcast different messages based on clock type
    const broadcastType = isClockIn(clockType) ? "clock_in" : "clock_out"
    const sessionType = getSessionType(clockType)

    broadcastUpdate("attendance_update", {
      type: broadcastType,
      sessionType: sessionType,
      employee: employee,
      clockType: clockType,
      time: currentDateTime.toISOString(),
      regularHours: attendanceRecord.regular_hours,
      overtimeHours: attendanceRecord.overtime_hours,
      // Add the full attendance record for debugging
      attendanceRecord: attendanceRecord,
    })

    console.log(`Clock ${broadcastType}: ${employee.first_name} ${employee.last_name} - ${sessionType} at ${attendanceRecord.clock_time}`)

    return {
      success: true,
      data: {
        employee: attendanceRecord.employee,
        clockType: clockType,
        sessionType: sessionType,
        clockTime: attendanceRecord.clock_time,
        regularHours: attendanceRecord.regular_hours,
        overtimeHours: attendanceRecord.overtime_hours,
        isOvertimeSession: isOvertimeSession(clockType),
      },
    }
  } catch (error) {
    console.error("Error clocking attendance:", error)
    return { success: false, error: error.message }
  }
}

// Helper function to check if clock type is a clock-in
function isClockIn(clockType) {
  return clockType.endsWith("_in")
}

// Helper function to check if clock type is a valid clock-out
function isValidClockOut(clockType) {
  return clockType.endsWith("_out")
}

// Helper function to get session type for display
function getSessionType(clockType) {
  if (clockType.startsWith("morning")) return "Morning"
  if (clockType.startsWith("afternoon")) return "Afternoon"
  if (clockType.startsWith("evening")) return "Evening (Overtime)"
  if (clockType.startsWith("overtime")) return "Overtime"
  return "Unknown"
}

// Helper function to check if this is an overtime session
function isOvertimeSession(clockType) {
  return clockType.startsWith("evening") || clockType.startsWith("overtime")
}

async function getTodayAttendance() {
  try {
    const attendance = Attendance.getTodayAttendance()
    const currentlyClocked = Attendance.getCurrentlyClocked()
    const stats = Attendance.getTodayStatistics()

    console.log("Raw attendance records:", attendance.length)
    console.log("Currently clocked employees:", currentlyClocked.length)
    console.log("Currently clocked data:", currentlyClocked.map(r => ({
      name: `${r.first_name} ${r.last_name}`,
      clockType: r.last_clock_type,
      time: r.last_clock_time
    })))

    // Enhance attendance data with session information
    const enhancedAttendance = attendance.map(record => ({
      ...record,
      sessionType: getSessionType(record.clock_type),
      isOvertimeSession: isOvertimeSession(record.clock_type),
    }))

    // Enhance currently clocked data - FIX: use last_clock_type instead of clock_type
    const enhancedCurrentlyClocked = currentlyClocked.map(record => ({
      ...record,
      sessionType: getSessionType(record.last_clock_type), // Fixed field name
      isOvertimeSession: isOvertimeSession(record.last_clock_type), // Fixed field name
      clock_type: record.last_clock_type, // Add for compatibility
    }))

    console.log("Enhanced currently clocked:", enhancedCurrentlyClocked.length)

    return {
      success: true,
      data: {
        attendance: enhancedAttendance,
        currentlyClocked: enhancedCurrentlyClocked,
        statistics: {
          ...stats,
          // Add overtime-specific statistics - FIX: use last_clock_type
          overtimeEmployees: enhancedCurrentlyClocked.filter(record => 
            isOvertimeSession(record.last_clock_type)
          ).length,
          eveningSessionEmployees: enhancedCurrentlyClocked.filter(record => 
            record.last_clock_type?.startsWith("evening")
          ).length,
        },
      },
    }
  } catch (error) {
    console.error("Error getting today attendance:", error)
    return { success: false, error: error.message }
  }
}

async function getEmployeeAttendance(event, { employeeUid, startDate, endDate }) {
  try {
    const attendance = Attendance.getEmployeeAttendance(employeeUid, startDate, endDate)
    
    // Enhance attendance data with session information and overtime details
    const enhancedAttendance = attendance.map(record => ({
      ...record,
      sessionType: getSessionType(record.clock_type),
      isOvertimeSession: isOvertimeSession(record.clock_type),
      // Add total hours calculation
      totalHours: (record.regular_hours || 0) + (record.overtime_hours || 0),
    }))

    // Calculate summary statistics
    const summary = {
      totalRegularHours: enhancedAttendance.reduce((sum, record) => sum + (record.regular_hours || 0), 0),
      totalOvertimeHours: enhancedAttendance.reduce((sum, record) => sum + (record.overtime_hours || 0), 0),
      totalDays: enhancedAttendance.length > 0 ? new Set(enhancedAttendance.map(record => record.date)).size : 0,
      eveningSessions: enhancedAttendance.filter(record => record.clock_type?.startsWith("evening")).length,
      overtimeSessions: enhancedAttendance.filter(record => isOvertimeSession(record.clock_type)).length,
    }

    summary.totalHours = summary.totalRegularHours + summary.totalOvertimeHours

    return { 
      success: true, 
      data: {
        attendance: enhancedAttendance,
        summary: summary,
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
    
    // Calculate enhanced statistics - FIX: use last_clock_type
    const enhancedStats = {
      ...stats,
      // Overtime-specific statistics
      currentOvertimeEmployees: currentlyClocked.filter(record => 
        isOvertimeSession(record.last_clock_type)
      ).length,
      currentEveningEmployees: currentlyClocked.filter(record => 
        record.last_clock_type?.startsWith("evening")
      ).length,
      // Session breakdown
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

// New function to get overtime summary
async function getOvertimeSummary(event, { startDate, endDate }) {
  try {
    const attendance = Attendance.getAttendanceByDateRange(startDate, endDate)
    
    const overtimeData = attendance
      .filter(record => isOvertimeSession(record.clock_type))
      .map(record => ({
        ...record,
        sessionType: getSessionType(record.clock_type),
      }))

    const summary = {
      totalOvertimeHours: overtimeData.reduce((sum, record) => sum + (record.overtime_hours || 0), 0),
      totalOvertimeSessions: overtimeData.length,
      employeesWithOvertime: new Set(overtimeData.map(record => record.employee_uid)).size,
      averageOvertimePerSession: overtimeData.length > 0 
        ? (overtimeData.reduce((sum, record) => sum + (record.overtime_hours || 0), 0) / overtimeData.length)
        : 0,
    }

    return {
      success: true,
      data: {
        overtimeRecords: overtimeData,
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
}