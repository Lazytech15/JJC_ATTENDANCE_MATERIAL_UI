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

  static getAttendanceByDateRange(startDate, endDate) {
    const db = getDatabase()
    let query = `
      SELECT a.*, e.first_name, e.last_name, e.department
      FROM attendance a
      JOIN employees e ON a.employee_uid = e.uid
      WHERE 1=1
    `

    const params = []

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

      let clockInType
      switch (clockType) {
        case "morning_out":
          clockInType = "morning_in"
          break
        case "afternoon_out":
          clockInType = "afternoon_in"
          break
        case "evening_out":
          clockInType = "evening_in"
          break
        case "overtime_out":
          clockInType = "overtime_in"
          break
        default:
          clockInType = clockType.replace("_out", "_in")
      }

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

  // First approach: Using CTE (for modern SQLite versions)
  const stmt = db.prepare(`
    WITH EmployeeLastClock AS (
      SELECT 
        a.employee_uid,
        e.first_name,
        e.last_name,
        e.department,
        e.profile_picture,
        a.clock_type as last_clock_type,
        a.clock_time as last_clock_time,
        ROW_NUMBER() OVER (PARTITION BY a.employee_uid ORDER BY a.clock_time DESC) as rn
      FROM attendance a
      JOIN employees e ON a.employee_uid = e.uid
      WHERE a.date = ?
    )
    SELECT 
      employee_uid,
      first_name,
      last_name,
      department,
      profile_picture,
      last_clock_time,
      last_clock_type
    FROM EmployeeLastClock
    WHERE rn = 1 
      AND last_clock_type IN ('morning_in', 'afternoon_in', 'evening_in', 'overtime_in')
    ORDER BY last_clock_time DESC
  `)

  try {
    return stmt.all(today)
  } catch (error) {
    // Fallback for older SQLite versions that don't support CTEs
    console.log("CTE not supported, using fallback query")
    
    const fallbackStmt = db.prepare(`
      SELECT DISTINCT 
        a1.employee_uid,
        e.first_name,
        e.last_name,
        e.department,
        e.profile_picture,
        a1.clock_time as last_clock_time,
        a1.clock_type as last_clock_type
      FROM attendance a1
      JOIN employees e ON a1.employee_uid = e.uid
      WHERE a1.date = ?
        AND a1.clock_time = (
          SELECT MAX(a2.clock_time) 
          FROM attendance a2 
          WHERE a2.employee_uid = a1.employee_uid AND a2.date = ?
        )
        AND a1.clock_type IN ('morning_in', 'afternoon_in', 'evening_in', 'overtime_in')
      ORDER BY a1.clock_time DESC
    `)
    
    return fallbackStmt.all(today, today)
  }
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

    // Get overtime statistics
    const overtimeStmt = db.prepare(`
      SELECT 
        COUNT(DISTINCT CASE WHEN clock_type IN ('evening_in', 'overtime_in') THEN employee_uid END) as overtimeEmployeesCount,
        COUNT(CASE WHEN clock_type LIKE 'evening_%' THEN 1 END) as eveningSessionsCount,
        COUNT(CASE WHEN clock_type LIKE 'overtime_%' THEN 1 END) as overtimeSessionsCount
      FROM attendance 
      WHERE date = ?
    `)
    const overtimeResult = overtimeStmt.get(today)

    return {
      totalRegularHours: Math.round(hoursResult.totalRegularHours * 100) / 100,
      totalOvertimeHours: Math.round(hoursResult.totalOvertimeHours * 100) / 100,
      presentCount: attendanceResult.presentCount || 0,
      lateCount: lateResult.lateCount || 0,
      absentCount: Math.max(0, absentCount),
      overtimeEmployeesCount: overtimeResult.overtimeEmployeesCount || 0,
      eveningSessionsCount: overtimeResult.eveningSessionsCount || 0,
      overtimeSessionsCount: overtimeResult.overtimeSessionsCount || 0,
    }
  }

  // New method to get overtime-specific data
  static getOvertimeStatistics(startDate = null, endDate = null) {
    const db = getDatabase()
    let query = `
      SELECT 
        COUNT(DISTINCT employee_uid) as uniqueOvertimeEmployees,
        COUNT(CASE WHEN clock_type LIKE 'evening_%' THEN 1 END) as totalEveningClocks,
        COUNT(CASE WHEN clock_type LIKE 'overtime_%' THEN 1 END) as totalOvertimeClocks,
        COALESCE(SUM(CASE WHEN clock_type LIKE '%_out' THEN overtime_hours END), 0) as totalOvertimeHours,
        COALESCE(AVG(CASE WHEN clock_type LIKE '%_out' AND overtime_hours > 0 THEN overtime_hours END), 0) as averageOvertimePerSession
      FROM attendance 
      WHERE (clock_type LIKE 'evening_%' OR clock_type LIKE 'overtime_%')
    `

    const params = []

    if (startDate) {
      query += " AND date >= ?"
      params.push(startDate)
    }

    if (endDate) {
      query += " AND date <= ?"
      params.push(endDate)
    }

    const stmt = db.prepare(query)
    const result = stmt.get(...params)

    return {
      uniqueOvertimeEmployees: result.uniqueOvertimeEmployees || 0,
      totalEveningClocks: result.totalEveningClocks || 0,
      totalOvertimeClocks: result.totalOvertimeClocks || 0,
      totalOvertimeHours: Math.round((result.totalOvertimeHours || 0) * 100) / 100,
      averageOvertimePerSession: Math.round((result.averageOvertimePerSession || 0) * 100) / 100,
    }
  }

  // New method to get employees currently in overtime
  static getCurrentOvertimeEmployees() {
    const db = getDatabase()
    const today = dateService.getCurrentDate()

    const stmt = db.prepare(`
      SELECT DISTINCT a.employee_uid, e.first_name, e.last_name, e.department, e.profile_picture,
             MAX(a.clock_time) as last_clock_time,
             (SELECT clock_type FROM attendance WHERE employee_uid = a.employee_uid AND date = ? ORDER BY clock_time DESC LIMIT 1) as last_clock_type,
             (SELECT clock_time FROM attendance WHERE employee_uid = a.employee_uid AND date = ? AND clock_type LIKE '%_in' ORDER BY clock_time DESC LIMIT 1) as clock_in_time
      FROM attendance a
      JOIN employees e ON a.employee_uid = e.uid
      WHERE a.date = ? AND a.clock_type IN ('evening_in', 'evening_out', 'overtime_in', 'overtime_out')
      GROUP BY a.employee_uid, e.first_name, e.last_name, e.department, e.profile_picture
      HAVING last_clock_type IN ('evening_in', 'overtime_in')
    `)

    return stmt.all(today, today, today)
  }

  // New method to check if employee has completed their regular shift for the day
  static hasCompletedRegularShift(employeeUid, date) {
    const db = getDatabase()
    const stmt = db.prepare(`
      SELECT COUNT(*) as completedSessions
      FROM attendance 
      WHERE employee_uid = ? 
        AND date = ? 
        AND clock_type IN ('morning_out', 'afternoon_out')
    `)

    const result = stmt.get(employeeUid, date)
    return (result.completedSessions || 0) >= 2 // Both morning and afternoon sessions completed
  }

  // New method to get session summary for an employee on a specific date
  static getEmployeeDaySummary(employeeUid, date) {
    const db = getDatabase()
    const stmt = db.prepare(`
      SELECT 
        clock_type,
        clock_time,
        regular_hours,
        overtime_hours,
        is_late
      FROM attendance 
      WHERE employee_uid = ? AND date = ?
      ORDER BY clock_time ASC
    `)

    const records = stmt.all(employeeUid, date)

    const summary = {
      date: date,
      sessions: {
        morning: { in: null, out: null, hours: 0, late: false },
        afternoon: { in: null, out: null, hours: 0, late: false },
        evening: { in: null, out: null, hours: 0, late: false },
        overtime: { in: null, out: null, hours: 0, late: false }
      },
      totalRegularHours: 0,
      totalOvertimeHours: 0,
      hasCompletedRegularShift: false
    }

    records.forEach(record => {
      const sessionType = record.clock_type.split('_')[0] // morning, afternoon, evening, overtime
      const clockAction = record.clock_type.split('_')[1] // in, out

      if (summary.sessions[sessionType]) {
        summary.sessions[sessionType][clockAction] = record.clock_time
        
        if (clockAction === 'out') {
          summary.sessions[sessionType].hours = (record.regular_hours || 0) + (record.overtime_hours || 0)
        }
        
        if (clockAction === 'in' && record.is_late) {
          summary.sessions[sessionType].late = true
        }
      }

      summary.totalRegularHours += record.regular_hours || 0
      summary.totalOvertimeHours += record.overtime_hours || 0
    })

    // Check if regular shift is completed
    summary.hasCompletedRegularShift = 
      summary.sessions.morning.out && summary.sessions.afternoon.out

    return summary
  }
}

module.exports = Attendance