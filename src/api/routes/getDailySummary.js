const Attendance = require("../../database/models/attendancedb")

async function getDailySummary(event, startDate = null, endDate = null) {
  try {
    console.log("[v0] getDailySummary called with:", { startDate, endDate })
    const summary = Attendance.getDailySummary(startDate, endDate)
    console.log("[v0] getDailySummary result count:", summary.length)
    return summary
  } catch (error) {
    console.error("[v0] Error in getDailySummary:", error)
    throw error
  }
}

async function getTodayAttendance() {
  try {
    return Attendance.getTodayAttendance()
  } catch (error) {
    console.error("Error getting today attendance:", error)
    throw error
  }
}

async function getEmployeeAttendance(event, employeeUid, dateRange) {
  try {
    const { startDate, endDate } = dateRange || {}
    return Attendance.getEmployeeAttendance(employeeUid, startDate, endDate)
  } catch (error) {
    console.error("Error getting employee attendance:", error)
    throw error
  }
}

async function getTodayStatistics() {
  try {
    return Attendance.getTodayStatistics()  } catch (error) {
    console.error("Error getting today statistics:", error)
    throw error
  }
}

async function clockAttendance(event, attendanceData) {
  try {
    // Implementation would depend on your existing clock attendance logic
    return { success: true, message: "Attendance clocked successfully" }
  } catch (error) {
    console.error("Error clocking attendance:", error)
    throw error
  }
}

module.exports = {
  getDailySummary,
  getTodayAttendance,
  getEmployeeAttendance,
  getTodayStatistics,
  clockAttendance,
}
