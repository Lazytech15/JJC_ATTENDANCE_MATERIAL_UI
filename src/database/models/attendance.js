const { getDatabase } = require("../setup")
const { calculateHours, isLate } = require("../../services/timeCalculator")
const dateService = require("../../services/dateService")

class Attendance {
  static getTodayAttendance() {
    const db = getDatabase()
    const today = dateService.getCurrentDate()

    const stmt = db.prepare(`
      SELECT a.*, e.first_name, e.last_name, e.profile_picture, e.department
      FROM attendance a
      JOIN employees e ON a.employee_uid = e.uid
      WHERE a.date = ?
      ORDER BY a.clock_time DESC
    `)

    return stmt.all(today)
  }

  static getEmployeeAttendance(employeeUid, startDate, endDate) {
    const db = getDatabase()
    let query = `
      SELECT a.*, e.first_name, e.last_name
      FROM attendance a
      JOIN employees e ON a.employee_uid = e.uid
      WHERE a.employee_uid = ?
    `

    const params = [employeeUid]

    if (startDate) {
      query += " AND a.date >= ?"
      params.push(startDate)
    }

    if (endDate) {
      query += " AND a.date <= ?"
      params.push(endDate)
    }

    query += " ORDER BY a.date DESC, a.clock_time DESC"

    const stmt = db.prepare(query)
    return stmt.all(...params)
  }

  static async clockIn(employee, clockType, profileService, serverUrl) {
    const db = getDatabase()
    const clockTime = dateService.getCurrentDateTime()
    const createdAt = dateService.getCurrentDateTime()
    const today = dateService.getCurrentDate()

    let profilePath = null
    if (profileService && serverUrl) {
      try {
        profilePath = await profileService.downloadAndStoreProfile(employee.id_number, serverUrl)
      } catch (error) {
        console.error("Error downloading profile:", error)
      }
    }

    const now = new Date(clockTime)
    let regularHours = 0
    let overtimeHours = 0

    let isEmployeeLate = 0
    if (clockType.endsWith("_in")) {
      isEmployeeLate = isLate(clockType, now) ? 1 : 0
    }

    if (clockType.endsWith("_out")) {
      // Get the corresponding clock_in time
      const clockInStmt = db.prepare(`
        SELECT clock_time FROM attendance 
        WHERE employee_uid = ? AND date = ? AND clock_type = ?
        ORDER BY clock_time DESC
        LIMIT 1
      `)

      const clockInType = clockType === "morning_out" ? "morning_in" : "afternoon_in"
      const clockInRecord = clockInStmt.get(employee.uid, today, clockInType)

      if (clockInRecord) {
        const clockInTime = new Date(clockInRecord.clock_time)
        const result = calculateHours(clockType, now, clockInTime)
        regularHours = result.regularHours
        overtimeHours = result.overtimeHours
      }
    }
    // For clock_in types, hours remain 0

    const stmt = db.prepare(`
      INSERT INTO attendance 
      (employee_uid, id_number, clock_type, clock_time, regular_hours, overtime_hours, is_late, date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const result = stmt.run(
      employee.uid,
      employee.id_number,
      clockType,
      clockTime,
      regularHours,
      overtimeHours,
      isEmployeeLate,
      today,
      createdAt,
    )

    return {
      id: result.lastInsertRowid,
      employee_uid: employee.uid,
      id_number: employee.id_number,
      clock_type: clockType,
      clock_time: clockTime,
      regular_hours: regularHours,
      overtime_hours: overtimeHours,
      is_late: isEmployeeLate,
      date: today,
      created_at: createdAt,
      employee: {
        ...employee,
        local_profile_path: profilePath,
      },
    }
  }

  static hasPendingClockIn(employeeUid, date) {
    const db = getDatabase()
    const stmt = db.prepare(`
      SELECT clock_type FROM attendance 
      WHERE employee_uid = ? AND date = ?
      ORDER BY clock_time DESC
      LIMIT 1
    `)

    const lastClock = stmt.get(employeeUid, date)

    return lastClock && lastClock.clock_type.endsWith("_in")
  }

  static getLastClockForEmployee(employeeUid, date) {
    const db = getDatabase()
    const stmt = db.prepare(`
      SELECT * FROM attendance 
      WHERE employee_uid = ? AND date = ?
      ORDER BY clock_time DESC
      LIMIT 1
    `)

    return stmt.get(employeeUid, date)
  }

  static getCurrentlyClocked() {
    const db = getDatabase()
    const today = dateService.getCurrentDate()

    const stmt = db.prepare(`
      SELECT DISTINCT a.employee_uid, e.first_name, e.last_name, e.department, e.profile_picture,
             MAX(a.clock_time) as last_clock_time,
             (SELECT clock_type FROM attendance WHERE employee_uid = a.employee_uid AND date = ? ORDER BY clock_time DESC LIMIT 1) as last_clock_type
      FROM attendance a
      JOIN employees e ON a.employee_uid = e.uid
      WHERE a.date = ?
      GROUP BY a.employee_uid, e.first_name, e.last_name, e.department, e.profile_picture
      HAVING last_clock_type IN ('morning_in', 'afternoon_in')
    `)

    return stmt.all(today, today)
  }

  static getTodayStatistics() {
    const db = getDatabase()
    const today = dateService.getCurrentDate()

    // Get total regular and overtime hours for today
    const hoursStmt = db.prepare(`
      SELECT 
        COALESCE(SUM(regular_hours), 0) as totalRegularHours,
        COALESCE(SUM(overtime_hours), 0) as totalOvertimeHours
      FROM attendance 
      WHERE date = ?
    `)
    const hoursResult = hoursStmt.get(today)

    // Get attendance counts
    const attendanceStmt = db.prepare(`
      SELECT 
        COUNT(DISTINCT employee_uid) as totalEmployees,
        COUNT(DISTINCT CASE WHEN clock_type LIKE '%_in' THEN employee_uid END) as presentCount
      FROM attendance 
      WHERE date = ?
    `)
    const attendanceResult = attendanceStmt.get(today)

    const lateStmt = db.prepare(`
      SELECT COUNT(DISTINCT employee_uid) as lateCount
      FROM attendance 
      WHERE date = ? 
        AND clock_type LIKE '%_in'
        AND is_late = 1
    `)
    const lateResult = lateStmt.get(today)

    // Get total employees from employees table for absent calculation
    const totalEmployeesStmt = db.prepare(`SELECT COUNT(*) as total FROM employees`)
    const totalEmployeesResult = totalEmployeesStmt.get()

    const absentCount = totalEmployeesResult.total - attendanceResult.presentCount

    return {
      totalRegularHours: Math.round(hoursResult.totalRegularHours * 100) / 100,
      totalOvertimeHours: Math.round(hoursResult.totalOvertimeHours * 100) / 100,
      presentCount: attendanceResult.presentCount || 0,
      lateCount: lateResult.lateCount || 0,
      absentCount: Math.max(0, absentCount),
    }
  }
}

module.exports = Attendance
