const { getDatabase } = require("../setup");
const { calculateHours, isLate } = require("../../services/timeCalculator");
const dateService = require("../../services/dateService");

class Attendance {
  static getTodayAttendance() {
    const db = getDatabase();
    const today = dateService.getCurrentDate();

    const stmt = db.prepare(`
      SELECT a.*, e.first_name, e.last_name, e.profile_picture, e.department
      FROM attendance a
      JOIN employees e ON a.employee_uid = e.uid
      WHERE a.date = ?
      ORDER BY a.clock_time DESC
    `);

    return stmt.all(today);
  }

  static getEmployeeAttendance(employeeUid, startDate, endDate) {
    const db = getDatabase();
    let query = `
      SELECT a.*, e.first_name, e.last_name
      FROM attendance a
      JOIN employees e ON a.employee_uid = e.uid
      WHERE a.employee_uid = ?
    `;

    const params = [employeeUid];

    if (startDate) {
      query += " AND a.date >= ?";
      params.push(startDate);
    }

    if (endDate) {
      query += " AND a.date <= ?";
      params.push(endDate);
    }

    query += " ORDER BY a.date DESC, a.clock_time DESC";

    const stmt = db.prepare(query);
    return stmt.all(...params);
  }

  static getAttendanceByDateRange(startDate, endDate) {
    const db = getDatabase();
    let query = `
      SELECT a.*, e.first_name, e.last_name, e.department
      FROM attendance a
      JOIN employees e ON a.employee_uid = e.uid
      WHERE 1=1
    `;

    const params = [];

    if (startDate) {
      query += " AND a.date >= ?";
      params.push(startDate);
    }

    if (endDate) {
      query += " AND a.date <= ?";
      params.push(endDate);
    }

    query += " ORDER BY a.date DESC, a.clock_time DESC";

    const stmt = db.prepare(query);
    return stmt.all(...params);
  }

  // NEW: Bulk download profiles for employees who clocked in today
  static async ensureTodayProfilesDownloaded(
    profileService,
    serverUrl,
    onProgress = null
  ) {
    if (!profileService || !serverUrl) {
      console.warn(
        "ProfileService or serverUrl not provided - skipping profile download"
      );
      return { success: false, message: "Missing required parameters" };
    }

    try {
      const db = getDatabase();
      const today = dateService.getCurrentDate();

      // Get all unique employee UIDs who have attendance records today
      const stmt = db.prepare(`
        SELECT DISTINCT a.employee_uid as uid, e.first_name, e.last_name
        FROM attendance a
        JOIN employees e ON a.employee_uid = e.uid
        WHERE a.date = ?
      `);

      const employeesWithAttendance = stmt.all(today);
      const employeeUids = employeesWithAttendance.map((emp) => emp.uid);

      if (employeeUids.length === 0) {
        return {
          success: true,
          message: "No attendance records for today - no profiles to download",
          downloaded: 0,
          total: 0,
        };
      }

      if (onProgress) {
        onProgress({
          stage: "checking",
          message: `Checking profiles for ${employeeUids.length} employees who clocked in today`,
          employees: employeesWithAttendance,
        });
      }

      // Check which profiles are missing
      const profileCheck = await profileService.checkProfileImages(
        employeeUids
      );

      if (profileCheck.missingUids.length === 0) {
        return {
          success: true,
          message: `All ${profileCheck.downloaded} profiles already downloaded`,
          downloaded: profileCheck.downloaded,
          total: profileCheck.total,
          alreadyExisted: true,
        };
      }

      if (onProgress) {
        onProgress({
          stage: "downloading",
          message: `Downloading ${profileCheck.missingUids.length} missing profiles`,
          missing: profileCheck.missingUids,
          existing: profileCheck.downloadedUids,
        });
      }

      // Bulk download missing profiles
      const downloadResult = await profileService.bulkDownloadSpecificEmployees(
        serverUrl,
        profileCheck.missingUids,
        onProgress
      );

      return {
        success: downloadResult.success,
        message: downloadResult.message,
        downloaded: Object.keys(downloadResult.profiles).length,
        total: employeeUids.length,
        previouslyDownloaded: profileCheck.downloaded,
        newlyDownloaded: Object.keys(downloadResult.profiles).length,
        profiles: downloadResult.profiles,
      };
    } catch (error) {
      console.error("Error ensuring today's profiles are downloaded:", error);
      return {
        success: false,
        error: error.message,
        downloaded: 0,
        total: 0,
      };
    }
  }

  // NEW: Bulk download profiles for all employees in attendance history
  static async ensureAllAttendanceProfilesDownloaded(
    profileService,
    serverUrl,
    dateRange = null,
    onProgress = null
  ) {
    if (!profileService || !serverUrl) {
      console.warn(
        "ProfileService or serverUrl not provided - skipping profile download"
      );
      return { success: false, message: "Missing required parameters" };
    }

    try {
      const db = getDatabase();
      let query = `
        SELECT DISTINCT a.employee_uid as uid, e.first_name, e.last_name, e.department
        FROM attendance a
        JOIN employees e ON a.employee_uid = e.uid
      `;

      const params = [];

      if (dateRange) {
        if (dateRange.startDate) {
          query += (params.length === 0 ? " WHERE" : " AND") + " a.date >= ?";
          params.push(dateRange.startDate);
        }
        if (dateRange.endDate) {
          query += (params.length === 0 ? " WHERE" : " AND") + " a.date <= ?";
          params.push(dateRange.endDate);
        }
      }

      const stmt = db.prepare(query);
      const employees = stmt.all(...params);
      const employeeUids = employees.map((emp) => emp.uid);

      if (employeeUids.length === 0) {
        return {
          success: true,
          message: "No attendance records found - no profiles to download",
          downloaded: 0,
          total: 0,
        };
      }

      if (onProgress) {
        onProgress({
          stage: "checking",
          message: `Checking profiles for ${employeeUids.length} employees in attendance history`,
          dateRange: dateRange,
        });
      }

      // Check current profile status
      const profileCheck = await profileService.checkProfileImages(
        employeeUids
      );

      if (profileCheck.missingUids.length === 0) {
        return {
          success: true,
          message: `All ${profileCheck.downloaded} profiles already downloaded`,
          downloaded: profileCheck.downloaded,
          total: profileCheck.total,
          alreadyExisted: true,
        };
      }

      // Bulk download missing profiles
      const downloadResult = await profileService.bulkDownloadSpecificEmployees(
        serverUrl,
        profileCheck.missingUids,
        onProgress
      );

      return {
        success: downloadResult.success,
        message: downloadResult.message,
        downloaded: Object.keys(downloadResult.profiles).length,
        total: employeeUids.length,
        previouslyDownloaded: profileCheck.downloaded,
        newlyDownloaded: Object.keys(downloadResult.profiles).length,
        profiles: downloadResult.profiles,
      };
    } catch (error) {
      console.error(
        "Error ensuring attendance profiles are downloaded:",
        error
      );
      return {
        success: false,
        error: error.message,
        downloaded: 0,
        total: 0,
      };
    }
  }

  // UPDATED: Clock in method now uses bulk profile downloading
  static async clockIn(employee, clockType, profileService, serverUrl) {
    const db = getDatabase();
    const clockTime = dateService.getCurrentDateTime();
    const createdAt = dateService.getCurrentDateTime();
    const today = dateService.getCurrentDate();

    // Check if we have the profile locally first
    let profilePath = null;
    if (profileService) {
      try {
        const existingProfilePath = profileService.ensureProfilesDirectory(
          employee.id_number
        );
        const profileExists = await profileService.profileExists(
          employee.id_number
        );

        if (profileExists) {
          profilePath = existingProfilePath;
          console.log(
            `Using existing profile for employee ${employee.id_number}`
          );
        } else if (serverUrl) {
          // If profile doesn't exist locally, trigger a bulk download for today's employees
          console.log(
            `Profile not found for employee ${employee.id_number}, triggering bulk download...`
          );

          // This will download profiles for all employees who clocked in today (including this one)
          const bulkResult = await this.ensureTodayProfilesDownloaded(
            profileService,
            serverUrl,
            (progress) => {
              console.log(
                `Bulk download progress: ${progress.stage} - ${progress.message}`
              );
            }
          );

          if (
            bulkResult.success &&
            bulkResult.profiles &&
            bulkResult.profiles[employee.id_number]
          ) {
            profilePath = bulkResult.profiles[employee.id_number].path;
            console.log(
              `Downloaded profile for employee ${employee.id_number} via bulk download`
            );
          } else {
            // Fallback to individual download if bulk fails
            console.warn(
              `Bulk download failed for employee ${employee.id_number}, attempting individual download...`
            );
            profilePath = await profileService.downloadAndStoreProfile(
              employee.id_number,
              serverUrl
            );
          }
        }
      } catch (error) {
        console.error(
          `Error handling profile for employee ${employee.id_number}:`,
          error
        );
      }
    }

    const now = new Date(clockTime);
    let regularHours = 0;
    let overtimeHours = 0;

    let isEmployeeLate = 0;
    if (clockType.endsWith("_in")) {
      isEmployeeLate = isLate(clockType, now) ? 1 : 0;
    }

    if (clockType.endsWith("_out")) {
      // Get the corresponding clock_in time
      const clockInStmt = db.prepare(`
        SELECT clock_time FROM attendance 
        WHERE employee_uid = ? AND date = ? AND clock_type = ?
        ORDER BY clock_time DESC
        LIMIT 1
      `);

      let clockInType;
      switch (clockType) {
        case "morning_out":
          clockInType = "morning_in";
          break;
        case "afternoon_out":
          clockInType = "afternoon_in";
          break;
        case "evening_out":
          clockInType = "evening_in";
          break;
        case "overtime_out":
          clockInType = "overtime_in";
          break;
        default:
          clockInType = clockType.replace("_out", "_in");
      }

      const clockInRecord = clockInStmt.get(employee.uid, today, clockInType);

      if (clockInRecord) {
        const clockInTime = new Date(clockInRecord.clock_time);
        const result = calculateHours(clockType, now, clockInTime);
        regularHours = result.regularHours;
        overtimeHours = result.overtimeHours;
      }
    }
    // For clock_in types, hours remain 0

    const stmt = db.prepare(`
      INSERT INTO attendance 
      (employee_uid, id_number, clock_type, clock_time, regular_hours, overtime_hours, is_late, date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      employee.uid,
      employee.id_number,
      clockType,
      clockTime,
      regularHours,
      overtimeHours,
      isEmployeeLate,
      today,
      createdAt
    );

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
    };
  }

  // NEW: Get attendance records with local profile paths
  static async getTodayAttendanceWithProfiles(profileService) {
    const attendance = this.getTodayAttendance();

    if (!profileService) {
      return attendance;
    }

    // Add local profile paths to attendance records
    return attendance.map((record) => {
      try {
        const profilePath = profileService.ensureProfilesDirectory(
          record.employee_uid
        );
        const profileExists = require("fs").existsSync(profilePath);

        return {
          ...record,
          local_profile_path: profileExists ? profilePath : null,
          has_local_profile: profileExists,
        };
      } catch (error) {
        console.warn(
          `Error checking profile for employee ${record.employee_uid}:`,
          error
        );
        return {
          ...record,
          local_profile_path: null,
          has_local_profile: false,
        };
      }
    });
  }

  static hasPendingClockIn(employeeUid, date) {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT clock_type FROM attendance 
      WHERE employee_uid = ? AND date = ?
      ORDER BY clock_time DESC
      LIMIT 1
    `);

    const lastClock = stmt.get(employeeUid, date);

    return lastClock && lastClock.clock_type.endsWith("_in");
  }

  static getLastClockForEmployee(employeeUid, date) {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM attendance 
      WHERE employee_uid = ? AND date = ?
      ORDER BY clock_time DESC
      LIMIT 1
    `);

    return stmt.get(employeeUid, date);
  }

  static getCurrentlyClocked() {
    const db = getDatabase();
    const today = dateService.getCurrentDate();

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
    `);

    try {
      return stmt.all(today);
    } catch (error) {
      // Fallback for older SQLite versions that don't support CTEs
      console.log("CTE not supported, using fallback query");

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
      `);

      return fallbackStmt.all(today, today);
    }
  }

  // NEW: Get currently clocked employees with local profile information
  static async getCurrentlyClockedWithProfiles(profileService) {
    const currentlyClocked = this.getCurrentlyClocked();

    if (!profileService) {
      return currentlyClocked;
    }

    return currentlyClocked.map((record) => {
      try {
        const profilePath = profileService.ensureProfilesDirectory(
          record.employee_uid
        );
        const profileExists = require("fs").existsSync(profilePath);

        return {
          ...record,
          local_profile_path: profileExists ? profilePath : null,
          has_local_profile: profileExists,
        };
      } catch (error) {
        console.warn(
          `Error checking profile for employee ${record.employee_uid}:`,
          error
        );
        return {
          ...record,
          local_profile_path: null,
          has_local_profile: false,
        };
      }
    });
  }

  static getTodayStatistics() {
    const db = getDatabase();
    const today = dateService.getCurrentDate();

    // Get total regular and overtime hours for today
    const hoursStmt = db.prepare(`
      SELECT 
        COALESCE(SUM(regular_hours), 0) as totalRegularHours,
        COALESCE(SUM(overtime_hours), 0) as totalOvertimeHours
      FROM attendance 
      WHERE date = ?
    `);
    const hoursResult = hoursStmt.get(today);

    // Get attendance counts
    const attendanceStmt = db.prepare(`
      SELECT 
        COUNT(DISTINCT employee_uid) as totalEmployees,
        COUNT(DISTINCT CASE WHEN clock_type LIKE '%_in' THEN employee_uid END) as presentCount
      FROM attendance 
      WHERE date = ?
    `);
    const attendanceResult = attendanceStmt.get(today);

    const lateStmt = db.prepare(`
      SELECT COUNT(DISTINCT employee_uid) as lateCount
      FROM attendance 
      WHERE date = ? 
        AND clock_type LIKE '%_in'
        AND is_late = 1
    `);
    const lateResult = lateStmt.get(today);

    // Get total employees from employees table for absent calculation
    const totalEmployeesStmt = db.prepare(
      `SELECT COUNT(*) as total FROM employees`
    );
    const totalEmployeesResult = totalEmployeesStmt.get();

    const absentCount =
      totalEmployeesResult.total - attendanceResult.presentCount;

    // Get overtime statistics
    const overtimeStmt = db.prepare(`
      SELECT 
        COUNT(DISTINCT CASE WHEN clock_type IN ('evening_in', 'overtime_in') THEN employee_uid END) as overtimeEmployeesCount,
        COUNT(CASE WHEN clock_type LIKE 'evening_%' THEN 1 END) as eveningSessionsCount,
        COUNT(CASE WHEN clock_type LIKE 'overtime_%' THEN 1 END) as overtimeSessionsCount
      FROM attendance 
      WHERE date = ?
    `);
    const overtimeResult = overtimeStmt.get(today);

    return {
      totalRegularHours: Math.round(hoursResult.totalRegularHours * 100) / 100,
      totalOvertimeHours:
        Math.round(hoursResult.totalOvertimeHours * 100) / 100,
      presentCount: attendanceResult.presentCount || 0,
      lateCount: lateResult.lateCount || 0,
      absentCount: Math.max(0, absentCount),
      overtimeEmployeesCount: overtimeResult.overtimeEmployeesCount || 0,
      eveningSessionsCount: overtimeResult.eveningSessionsCount || 0,
      overtimeSessionsCount: overtimeResult.overtimeSessionsCount || 0,
    };
  }

  // New method to get overtime-specific data
  static getOvertimeStatistics(startDate = null, endDate = null) {
    const db = getDatabase();
    let query = `
      SELECT 
        COUNT(DISTINCT employee_uid) as uniqueOvertimeEmployees,
        COUNT(CASE WHEN clock_type LIKE 'evening_%' THEN 1 END) as totalEveningClocks,
        COUNT(CASE WHEN clock_type LIKE 'overtime_%' THEN 1 END) as totalOvertimeClocks,
        COALESCE(SUM(CASE WHEN clock_type LIKE '%_out' THEN overtime_hours END), 0) as totalOvertimeHours,
        COALESCE(AVG(CASE WHEN clock_type LIKE '%_out' AND overtime_hours > 0 THEN overtime_hours END), 0) as averageOvertimePerSession
      FROM attendance 
      WHERE (clock_type LIKE 'evening_%' OR clock_type LIKE 'overtime_%')
    `;

    const params = [];

    if (startDate) {
      query += " AND date >= ?";
      params.push(startDate);
    }

    if (endDate) {
      query += " AND date <= ?";
      params.push(endDate);
    }

    const stmt = db.prepare(query);
    const result = stmt.get(...params);

    return {
      uniqueOvertimeEmployees: result.uniqueOvertimeEmployees || 0,
      totalEveningClocks: result.totalEveningClocks || 0,
      totalOvertimeClocks: result.totalOvertimeClocks || 0,
      totalOvertimeHours:
        Math.round((result.totalOvertimeHours || 0) * 100) / 100,
      averageOvertimePerSession:
        Math.round((result.averageOvertimePerSession || 0) * 100) / 100,
    };
  }

  // New method to get employees currently in overtime
  static getCurrentOvertimeEmployees() {
    const db = getDatabase();
    const today = dateService.getCurrentDate();

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
    `);

    return stmt.all(today, today, today);
  }

  // NEW: Get current overtime employees with profile information
  static async getCurrentOvertimeEmployeesWithProfiles(profileService) {
    const overtimeEmployees = this.getCurrentOvertimeEmployees();

    if (!profileService) {
      return overtimeEmployees;
    }

    return overtimeEmployees.map((record) => {
      try {
        const profilePath = profileService.ensureProfilesDirectory(
          record.employee_uid
        );
        const profileExists = require("fs").existsSync(profilePath);

        return {
          ...record,
          local_profile_path: profileExists ? profilePath : null,
          has_local_profile: profileExists,
        };
      } catch (error) {
        console.warn(
          `Error checking profile for employee ${record.employee_uid}:`,
          error
        );
        return {
          ...record,
          local_profile_path: null,
          has_local_profile: false,
        };
      }
    });
  }

  // New method to check if employee has completed their regular shift for the day
  static hasCompletedRegularShift(employeeUid, date) {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT COUNT(*) as completedSessions
      FROM attendance 
      WHERE employee_uid = ? 
        AND date = ? 
        AND clock_type IN ('morning_out', 'afternoon_out')
    `);

    const result = stmt.get(employeeUid, date);
    return (result.completedSessions || 0) >= 2; // Both morning and afternoon sessions completed
  }

  // New method to get session summary for an employee on a specific date
  static getEmployeeDaySummary(employeeUid, date) {
    const db = getDatabase();
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
    `);

    const records = stmt.all(employeeUid, date);

    const summary = {
      date: date,
      sessions: {
        morning: { in: null, out: null, hours: 0, late: false },
        afternoon: { in: null, out: null, hours: 0, late: false },
        evening: { in: null, out: null, hours: 0, late: false },
        overtime: { in: null, out: null, hours: 0, late: false },
      },
      totalRegularHours: 0,
      totalOvertimeHours: 0,
      hasCompletedRegularShift: false,
    };

    records.forEach((record) => {
      const sessionType = record.clock_type.split("_")[0]; // morning, afternoon, evening, overtime
      const clockAction = record.clock_type.split("_")[1]; // in, out

      if (summary.sessions[sessionType]) {
        summary.sessions[sessionType][clockAction] = record.clock_time;

        if (clockAction === "out") {
          summary.sessions[sessionType].hours =
            (record.regular_hours || 0) + (record.overtime_hours || 0);
        }

        if (clockAction === "in" && record.is_late) {
          summary.sessions[sessionType].late = true;
        }
      }

      summary.totalRegularHours += record.regular_hours || 0;
      summary.totalOvertimeHours += record.overtime_hours || 0;
    });

    // Check if regular shift is completed
    summary.hasCompletedRegularShift =
      summary.sessions.morning.out && summary.sessions.afternoon.out;

    return summary;
  }

  static getDailySummary(options = {}) {
    const {
      startDate = null,
      endDate = null,
      employeeId = null,
      department = null,
      includeIncomplete = true,
      sortBy = "date",
      sortOrder = "DESC",
    } = options;

    const db = getDatabase();

    let query = `
    SELECT 
      id,
      employee_uid,
      id_number,
      id_barcode,
      employee_name,
      first_name,
      last_name,
      department,
      date,
      first_clock_in,
      last_clock_out,
      morning_in,
      morning_out,
      afternoon_in,
      afternoon_out,
      evening_in,
      evening_out,
      overtime_in,
      overtime_out,
      regular_hours,
      overtime_hours,
      total_hours,
      morning_hours,
      afternoon_hours,
      evening_hours,
      overtime_session_hours,
      is_incomplete,
      has_late_entry,
      has_overtime,
      has_evening_session,
      total_sessions,
      completed_sessions,
      pending_sessions,
      total_minutes_worked,
      break_time_minutes,
      last_updated,
      created_at
    FROM daily_attendance_summary
    WHERE 1=1
  `;

    const params = [];
    const conditions = [];

    // Date range filtering
    if (startDate) {
      conditions.push("date >= ?");
      params.push(this.formatDateForDB(startDate));
    }

    if (endDate) {
      conditions.push("date <= ?");
      params.push(this.formatDateForDB(endDate));
    }

    // Employee filtering
    if (employeeId) {
      conditions.push("(employee_uid = ? OR id_number = ?)");
      params.push(employeeId, employeeId);
    }

    // Department filtering
    if (department) {
      conditions.push("department = ?");
      params.push(department);
    }

    // Include/exclude incomplete records
    if (!includeIncomplete) {
      conditions.push("is_incomplete = 0");
    }

    // Add conditions to query
    if (conditions.length > 0) {
      query += " AND " + conditions.join(" AND ");
    }

    // Sorting
    const validSortColumns = [
      "date",
      "employee_name",
      "total_hours",
      "department",
    ];
    const validSortOrders = ["ASC", "DESC"];

    const safeSortBy = validSortColumns.includes(sortBy) ? sortBy : "date";
    const safeSortOrder = validSortOrders.includes(sortOrder.toUpperCase())
      ? sortOrder.toUpperCase()
      : "DESC";

    query += ` ORDER BY ${safeSortBy} ${safeSortOrder}`;

    // Add secondary sort by employee name if not already sorting by it
    if (safeSortBy !== "employee_name") {
      query += ", employee_name ASC";
    }

    try {
      const stmt = db.prepare(query);
      console.log("Executing advanced query:", query);
      console.log("With parameters:", params);

      const results = stmt.all(...params);
      console.log(`Advanced query returned ${results.length} records`);

      return {
        success: true,
        data: results,
        totalRecords: results.length,
        filters: {
          startDate,
          endDate,
          employeeId,
          department,
          includeIncomplete,
        },
      };
    } catch (error) {
      console.error("Error in advanced daily summary query:", error);
      return {
        success: false,
        error: error.message,
        data: [],
      };
    }
  }

  // Helper method to format date for database
  static formatDateForDB(date) {
    if (!date) return null;

    if (date instanceof Date) {
      return (
        date.getFullYear() +
        "-" +
        String(date.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(date.getDate()).padStart(2, "0")
      );
    }

    if (typeof date === "string") {
      // If already in YYYY-MM-DD format, return as is
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return date;
      }

      // Try to parse and format
      const parsedDate = new Date(date);
      if (!isNaN(parsedDate.getTime())) {
        return (
          parsedDate.getFullYear() +
          "-" +
          String(parsedDate.getMonth() + 1).padStart(2, "0") +
          "-" +
          String(parsedDate.getDate()).padStart(2, "0")
        );
      }
    }

    console.warn("Could not format date for DB:", date);
    return null;
  }

  static formatDateTimeForExport(dateTimeString) {
    if (!dateTimeString) return "";

    try {
      const date = new Date(dateTimeString);
      const options = {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      };
      return date.toLocaleDateString("en-US", options);
    } catch (error) {
      console.error("Error formatting date:", error);
      return dateTimeString;
    }
  }
}

module.exports = Attendance;
