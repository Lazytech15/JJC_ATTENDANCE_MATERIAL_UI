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

    const hasPendingClockIn = Attendance.hasPendingClockIn(employee.uid, today)

    let clockType
    if (hasPendingClockIn) {
      const lastClock = Attendance.getLastClockForEmployee(employee.uid, today)
      clockType = lastClock.clock_type === "morning_in" ? "morning_out" : "afternoon_out"
    } else {
      const lastClock = Attendance.getLastClockForEmployee(employee.uid, today)
      clockType = determineClockType(lastClock?.clock_type, currentDateTime)
    }

    const settingsResult = await settingsRoutes.getSettings()
    const serverUrl = settingsResult.success ? settingsResult.data.serverUrl : "http://localhost:3000"

    // Record attendance with profile service
    const attendanceRecord = await Attendance.clockIn(employee, clockType, profileService, serverUrl)

    broadcastUpdate("attendance_update", {
      type: "clock",
      employee: employee,
      clockType: clockType,
      time: currentDateTime.toISOString(),
    })

    return {
      success: true,
      data: {
        employee: attendanceRecord.employee,
        clockType: clockType,
        clockTime: attendanceRecord.clock_time,
        regularHours: attendanceRecord.regular_hours,
        overtimeHours: attendanceRecord.overtime_hours,
      },
    }
  } catch (error) {
    console.error("Error clocking attendance:", error)
    return { success: false, error: error.message }
  }
}

async function getTodayAttendance() {
  try {
    const attendance = Attendance.getTodayAttendance()
    const currentlyClocked = Attendance.getCurrentlyClocked()
    const stats = Attendance.getTodayStatistics()

    return {
      success: true,
      data: {
        attendance: attendance,
        currentlyClocked: currentlyClocked,
        statistics: stats,
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
    return { success: true, data: attendance }
  } catch (error) {
    console.error("Error getting employee attendance:", error)
    return { success: false, error: error.message }
  }
}

// Add the missing getTodayStatistics handler function
async function getTodayStatistics() {
  try {
    const stats = Attendance.getTodayStatistics()
    return {
      success: true,
      data: stats,
    }
  } catch (error) {
    console.error("Error getting today statistics:", error)
    return { success: false, error: error.message }
  }
}

module.exports = {
  clockAttendance,
  getTodayAttendance,
  getEmployeeAttendance,
  getTodayStatistics, // Add this to the exports
}