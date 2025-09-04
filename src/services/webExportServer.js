// services/webExportServer.js
const express = require('express')
const cors = require('cors')
const { getDatabase } = require('../database/setup')
const Employee = require('../database/models/employee')
const ProfileService = require('./profileService')

class WebExportServer {
  constructor(port = 3001) {
    this.app = express()
    this.port = port
    this.server = null
    this.setupMiddleware()
    this.setupRoutes()
  }

  setupMiddleware() {
    // Enable CORS for all routes
    this.app.use(cors())
    
    // Parse JSON bodies
    this.app.use(express.json())
    
    // Add request logging
    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`)
      next()
    })
  }

  setupRoutes() {
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        service: 'Attendance Export API'
      })
    })

    // Get all employees endpoint with attendance data
    this.app.get('/employees', async (req, res) => {
      try {
        const includeProfiles = req.query.includeProfiles === 'true'
        const includeAttendance = req.query.includeAttendance === 'true'
        const startDate = req.query.startDate
        const endDate = req.query.endDate
        const limit = req.query.limit ? parseInt(req.query.limit) : null
        
        const employees = await this.getAllEmployeesWithDetails({
          includeProfiles,
          includeAttendance,
          startDate,
          endDate,
          limit
        })
        
        res.json({
          success: true,
          data: employees,
          count: employees.length
        })

      } catch (error) {
        console.error('Employees API error:', error)
        res.status(500).json({
          error: 'Internal server error',
          message: error.message,
          success: false
        })
      }
    })

    // Get single employee with attendance data
    this.app.get('/employees/:idNumber', async (req, res) => {
      try {
        const { idNumber } = req.params
        const includeProfiles = req.query.includeProfiles === 'true'
        const includeAttendance = req.query.includeAttendance === 'true'
        const startDate = req.query.startDate
        const endDate = req.query.endDate
        const limit = req.query.limit ? parseInt(req.query.limit) : null
        
        const employee = await this.getEmployeeWithAttendance({
          idNumber,
          includeProfiles,
          includeAttendance,
          startDate,
          endDate,
          limit
        })
        
        if (!employee) {
          return res.status(404).json({
            error: 'Employee not found',
            success: false
          })
        }
        
        res.json({
          success: true,
          data: employee
        })

      } catch (error) {
        console.error('Employee API error:', error)
        res.status(500).json({
          error: 'Internal server error',
          message: error.message,
          success: false
        })
      }
    })

    // Export all attendance data
    this.app.get('/export/data', async (req, res) => {
      try {
        const {
          format = 'json',
          startDate,
          endDate,
          includeEmployees = 'true',
          includeProfiles = 'false',
          download = 'false'
        } = req.query

        const includeEmployeeDetails = includeEmployees === 'true'
        const includeProfileInfo = includeProfiles === 'true'
        const forceDownload = download === 'true'

        const result = await this.exportAttendanceData({
          format,
          startDate,
          endDate,
          includeEmployeeDetails,
          includeProfileInfo
        })

        if (!result.success) {
          return res.status(400).json({
            error: result.message,
            success: false
          })
        }

        // Set appropriate headers based on format
        if (format === 'csv') {
          res.setHeader('Content-Type', 'text/csv')
          if (forceDownload) {
            res.setHeader('Content-Disposition', `attachment; filename="attendance_export_${new Date().toISOString().split('T')[0]}.csv"`)
          }
          res.send(result.data)
        } else {
          res.setHeader('Content-Type', 'application/json')
          if (forceDownload) {
            res.setHeader('Content-Disposition', `attachment; filename="attendance_export_${new Date().toISOString().split('T')[0]}.json"`)
          }
          res.json(result.data)
        }

      } catch (error) {
        console.error('Export API error:', error)
        res.status(500).json({
          error: 'Internal server error',
          message: error.message,
          success: false
        })
      }
    })

    // Export statistics endpoint
    this.app.get('/export/stats', async (req, res) => {
      try {
        const { startDate, endDate } = req.query
        
        const stats = await this.getExportStatistics({ startDate, endDate })
        
        if (!stats.success) {
          return res.status(400).json({
            error: stats.message,
            success: false
          })
        }

        res.json({
          success: true,
          statistics: stats.statistics
        })

      } catch (error) {
        console.error('Stats API error:', error)
        res.status(500).json({
          error: 'Internal server error',
          message: error.message,
          success: false
        })
      }
    })

    // Export formats endpoint
    this.app.get('/export/formats', (req, res) => {
      res.json({
        success: true,
        formats: [
          { value: 'csv', label: 'CSV (Comma Separated Values)', mimeType: 'text/csv' },
          { value: 'json', label: 'JSON (JavaScript Object Notation)', mimeType: 'application/json' }
        ]
      })
    })

    // Employee statistics endpoint
    this.app.get('/employees/stats', async (req, res) => {
      try {
        const stats = await this.getEmployeeStatistics()
        res.json({
          success: true,
          statistics: stats
        })
      } catch (error) {
        console.error('Employee stats API error:', error)
        res.status(500).json({
          error: 'Internal server error',
          message: error.message,
          success: false
        })
      }
    })

    // API documentation endpoint
    this.app.get('/api/docs', (req, res) => {
      const baseUrl = `http://localhost:${this.port}`
      res.json({
        title: 'Attendance Export API',
        version: '1.0.0',
        baseUrl,
        endpoints: [
          {
            method: 'GET',
            path: '/health',
            description: 'Health check endpoint',
            example: `${baseUrl}/health`
          },
          {
            method: 'GET',
            path: '/employees',
            description: 'Get all employees with complete details and optional attendance data',
            parameters: {
              includeProfiles: 'true | false (default: false) - includes profile image info',
              includeAttendance: 'true | false (default: false) - includes attendance records',
              startDate: 'YYYY-MM-DD (optional) - filter attendance from this date',
              endDate: 'YYYY-MM-DD (optional) - filter attendance to this date',
              limit: 'number (optional) - limit attendance records per employee'
            },
            examples: [
              `${baseUrl}/employees`,
              `${baseUrl}/employees?includeProfiles=true`,
              `${baseUrl}/employees?includeAttendance=true`,
              `${baseUrl}/employees?includeAttendance=true&startDate=2024-01-01&endDate=2024-12-31`,
              `${baseUrl}/employees?includeAttendance=true&limit=50`
            ]
          },
          {
            method: 'GET',
            path: '/employees/:idNumber',
            description: 'Get single employee by ID number with optional attendance data',
            parameters: {
              includeProfiles: 'true | false (default: false) - includes profile image info',
              includeAttendance: 'true | false (default: false) - includes attendance records',
              startDate: 'YYYY-MM-DD (optional) - filter attendance from this date',
              endDate: 'YYYY-MM-DD (optional) - filter attendance to this date',
              limit: 'number (optional) - limit attendance records'
            },
            examples: [
              `${baseUrl}/employees/12345`,
              `${baseUrl}/employees/12345?includeAttendance=true`,
              `${baseUrl}/employees/12345?includeAttendance=true&startDate=2024-01-01`
            ]
          },
          {
            method: 'GET',
            path: '/employees/stats',
            description: 'Get employee statistics',
            example: `${baseUrl}/employees/stats`
          },
          {
            method: 'GET',
            path: '/export/data',
            description: 'Export attendance data with complete employee details',
            parameters: {
              format: 'csv | json (default: json)',
              startDate: 'YYYY-MM-DD (optional)',
              endDate: 'YYYY-MM-DD (optional)',
              includeEmployees: 'true | false (default: true)',
              includeProfiles: 'true | false (default: false) - includes profile image info',
              download: 'true | false (default: false) - forces download headers'
            },
            examples: [
              `${baseUrl}/export/data`,
              `${baseUrl}/export/data?format=csv`,
              `${baseUrl}/export/data?format=csv&download=true`,
              `${baseUrl}/export/data?startDate=2024-01-01&endDate=2024-12-31`,
              `${baseUrl}/export/data?format=json&includeEmployees=true&includeProfiles=true`
            ]
          },
          {
            method: 'GET',
            path: '/export/stats',
            description: 'Get export statistics',
            parameters: {
              startDate: 'YYYY-MM-DD (optional)',
              endDate: 'YYYY-MM-DD (optional)'
            },
            example: `${baseUrl}/export/stats?startDate=2024-01-01`
          },
          {
            method: 'GET',
            path: '/export/formats',
            description: 'Get available export formats',
            example: `${baseUrl}/export/formats`
          }
        ]
      })
    })

    this.app.use((req, res) => {
      res.status(404).json({
        error: 'Endpoint not found',
        message: `The endpoint ${req.method} ${req.originalUrl} does not exist`,
        availableEndpoints: [
          '/health',
          '/employees',
          '/employees/:idNumber',
          '/employees/stats',
          '/export/data',
          '/export/stats',
          '/export/formats',
          '/api/docs'
        ]
      });
    });
  }

  /**
   * Get all employees with complete details and optional attendance data
   */
  async getAllEmployeesWithDetails(options = {}) {
    try {
      const {
        includeProfiles = false,
        includeAttendance = false,
        startDate = null,
        endDate = null,
        limit = null
      } = options

      // Use the existing Employee.getAll() method
      const employees = Employee.getAll()
      
      // Add profile information if requested
      if (includeProfiles && ProfileService) {
        for (const employee of employees) {
          try {
            const hasProfile = await ProfileService.profileExists(employee.id_number)
            employee.hasProfileImage = hasProfile
            if (hasProfile) {
              employee.profileImagePath = `profiles/${employee.id_number}.jpg`
            }
          } catch (error) {
            employee.hasProfileImage = false
            employee.profileImagePath = null
          }
        }
      }

      // Add attendance data if requested
      if (includeAttendance) {
        const db = getDatabase()
        
        for (const employee of employees) {
          const attendanceRecords = this.getEmployeeAttendanceRecords({
            db,
            idNumber: employee.id_number,
            startDate,
            endDate,
            limit
          })
          
          employee.attendanceRecords = attendanceRecords
          employee.attendanceStats = this.calculateAttendanceStats(attendanceRecords)
        }
      }

      return employees
    } catch (error) {
      console.error('Error getting employees with details:', error)
      throw error
    }
  }

  /**
   * Get single employee with attendance data
   */
  async getEmployeeWithAttendance(options = {}) {
    try {
      const {
        idNumber,
        includeProfiles = false,
        includeAttendance = false,
        startDate = null,
        endDate = null,
        limit = null
      } = options

      // Get employee by ID number
      const employees = Employee.getAll()
      const employee = employees.find(emp => emp.id_number === idNumber)
      
      if (!employee) {
        return null
      }

      // Add profile information if requested
      if (includeProfiles && ProfileService) {
        try {
          const hasProfile = await ProfileService.profileExists(employee.id_number)
          employee.hasProfileImage = hasProfile
          if (hasProfile) {
            employee.profileImagePath = `profiles/${employee.id_number}.jpg`
          }
        } catch (error) {
          employee.hasProfileImage = false
          employee.profileImagePath = null
        }
      }

      // Add attendance data if requested
      if (includeAttendance) {
        const db = getDatabase()
        
        const attendanceRecords = this.getEmployeeAttendanceRecords({
          db,
          idNumber: employee.id_number,
          startDate,
          endDate,
          limit
        })
        
        employee.attendanceRecords = attendanceRecords
        employee.attendanceStats = this.calculateAttendanceStats(attendanceRecords)
      }

      return employee
    } catch (error) {
      console.error('Error getting employee with attendance:', error)
      throw error
    }
  }

  /**
   * Get attendance records for a specific employee
   */
  getEmployeeAttendanceRecords(options = {}) {
    const { db, idNumber, startDate = null, endDate = null, limit = null } = options

    let query = 'SELECT * FROM attendance WHERE id_number = ?'
    const params = [idNumber]
    
    if (startDate) {
      query += ' AND date >= ?'
      params.push(startDate)
    }
    
    if (endDate) {
      query += ' AND date <= ?'
      params.push(endDate)
    }
    
    query += ' ORDER BY date DESC, clock_time DESC'
    
    if (limit) {
      query += ' LIMIT ?'
      params.push(limit)
    }

    return db.prepare(query).all(...params)
  }

  /**
   * Calculate attendance statistics for an employee
   */
  calculateAttendanceStats(attendanceRecords) {
    const stats = {
      totalRecords: attendanceRecords.length,
      totalRegularHours: 0,
      totalOvertimeHours: 0,
      totalLateInstances: 0,
      clockTypeBreakdown: {
        morning_in: 0,
        morning_out: 0,
        afternoon_in: 0,
        afternoon_out: 0
      },
      dateRange: {
        earliest: null,
        latest: null
      },
      uniqueDays: new Set()
    }

    attendanceRecords.forEach(record => {
      // Sum hours
      stats.totalRegularHours += record.regular_hours || 0
      stats.totalOvertimeHours += record.overtime_hours || 0
      
      // Count late instances
      if (record.is_late) {
        stats.totalLateInstances++
      }
      
      // Count clock types
      if (record.clock_type && stats.clockTypeBreakdown.hasOwnProperty(record.clock_type)) {
        stats.clockTypeBreakdown[record.clock_type]++
      }
      
      // Track date range
      if (record.date) {
        if (!stats.dateRange.earliest || record.date < stats.dateRange.earliest) {
          stats.dateRange.earliest = record.date
        }
        if (!stats.dateRange.latest || record.date > stats.dateRange.latest) {
          stats.dateRange.latest = record.date
        }
        stats.uniqueDays.add(record.date)
      }
    })

    // Convert Set to count
    stats.uniqueWorkDays = stats.uniqueDays.size
    delete stats.uniqueDays // Remove the Set object from final stats

    return stats
  }

  /**
   * Get employee statistics
   */
  async getEmployeeStatistics() {
    try {
      const employees = Employee.getAll()
      const db = getDatabase()
      
      // Get attendance statistics
      const attendanceStats = db.prepare(`
        SELECT 
          COUNT(*) as totalAttendanceRecords,
          COUNT(DISTINCT id_number) as employeesWithAttendance,
          SUM(regular_hours) as totalRegularHours,
          SUM(overtime_hours) as totalOvertimeHours,
          SUM(is_late) as totalLateInstances,
          MIN(date) as earliestAttendanceDate,
          MAX(date) as latestAttendanceDate
        FROM attendance
      `).get()

      const stats = {
        totalEmployees: employees.length,
        departments: {},
        statuses: {},
        activeEmployees: 0,
        inactiveEmployees: 0,
        employeesWithEmail: 0,
        employeesWithoutEmail: 0,
        employeesWithProfilePicture: 0,
        attendance: {
          totalRecords: attendanceStats.totalAttendanceRecords || 0,
          employeesWithAttendance: attendanceStats.employeesWithAttendance || 0,
          employeesWithoutAttendance: employees.length - (attendanceStats.employeesWithAttendance || 0),
          totalRegularHours: attendanceStats.totalRegularHours || 0,
          totalOvertimeHours: attendanceStats.totalOvertimeHours || 0,
          totalLateInstances: attendanceStats.totalLateInstances || 0,
          dateRange: {
            earliest: attendanceStats.earliestAttendanceDate,
            latest: attendanceStats.latestAttendanceDate
          }
        }
      }

      employees.forEach(employee => {
        // Count departments
        if (employee.department) {
          stats.departments[employee.department] = (stats.departments[employee.department] || 0) + 1
        } else {
          stats.departments['No Department'] = (stats.departments['No Department'] || 0) + 1
        }

        // Count statuses
        const status = employee.status || 'Unknown'
        stats.statuses[status] = (stats.statuses[status] || 0) + 1

        // Count active/inactive
        if (employee.status === 'Active' || employee.status === 'active') {
          stats.activeEmployees++
        } else {
          stats.inactiveEmployees++
        }

        // Count employees with email
        if (employee.email && employee.email.trim()) {
          stats.employeesWithEmail++
        } else {
          stats.employeesWithoutEmail++
        }

        // Count employees with profile picture
        if (employee.profile_picture) {
          stats.employeesWithProfilePicture++
        }
      })

      return stats
    } catch (error) {
      console.error('Error getting employee statistics:', error)
      throw error
    }
  }

  async exportAttendanceData(options = {}) {
    try {
      const db = getDatabase()
      const { 
        format = 'json', 
        startDate = null, 
        endDate = null,
        includeEmployeeDetails = true,
        includeProfileInfo = false
      } = options

      // First get all attendance records
      let query = 'SELECT * FROM attendance'
      const params = []
      const whereConditions = []

      if (startDate) {
        whereConditions.push('date >= ?')
        params.push(startDate)
      }

      if (endDate) {
        whereConditions.push('date <= ?')
        params.push(endDate)
      }

      if (whereConditions.length > 0) {
        query += ' WHERE ' + whereConditions.join(' AND ')
      }

      query += ' ORDER BY date DESC, clock_time DESC'

      const attendanceRecords = db.prepare(query).all(...params)
      
      if (attendanceRecords.length === 0) {
        return {
          success: false,
          message: 'No data found for the specified criteria'
        }
      }

      // If employee details are requested, get all employees and create a lookup map
      let employeeMap = {}
      if (includeEmployeeDetails) {
        const employees = await this.getAllEmployeesWithDetails({ includeProfiles: includeProfileInfo })
        // Create a map for quick lookup by id_number (matching attendance.id_number)
        employees.forEach(employee => {
          employeeMap[employee.id_number] = employee
        })
      }

      // Merge attendance data with employee details
      const enrichedData = attendanceRecords.map(record => {
        const enrichedRecord = { ...record }
        
        if (includeEmployeeDetails && employeeMap[record.id_number]) {
          const employee = employeeMap[record.id_number]
          enrichedRecord.employee_name = employee.name
          enrichedRecord.employee_uid = employee.uid
          enrichedRecord.employee_department = employee.department
          enrichedRecord.employee_position = employee.position
          enrichedRecord.employee_email = employee.email
          enrichedRecord.employee_phone = employee.phone
          enrichedRecord.employee_address = employee.address
          enrichedRecord.employee_hire_date = employee.hire_date
          enrichedRecord.employee_status = employee.status || employee.active
          
          if (includeProfileInfo) {
            enrichedRecord.employee_has_profile = employee.hasProfileImage || false
            enrichedRecord.employee_profile_path = employee.profileImagePath || null
          }
        } else if (includeEmployeeDetails) {
          // Employee not found, set null values
          enrichedRecord.employee_name = null
          enrichedRecord.employee_uid = null
          enrichedRecord.employee_department = null
          enrichedRecord.employee_position = null
          enrichedRecord.employee_email = null
          enrichedRecord.employee_phone = null
          enrichedRecord.employee_address = null
          enrichedRecord.employee_hire_date = null
          enrichedRecord.employee_status = null
          
          if (includeProfileInfo) {
            enrichedRecord.employee_has_profile = false
            enrichedRecord.employee_profile_path = null
          }
        }

        return enrichedRecord
      })

      let exportData
      if (format === 'csv') {
        exportData = this.convertToCSV(enrichedData)
      } else {
        exportData = {
          exportDate: new Date().toISOString(),
          recordCount: enrichedData.length,
          filters: {
            startDate: startDate || 'all',
            endDate: endDate || 'all',
            includeEmployeeDetails,
            includeProfileInfo
          },
          employeeCount: Object.keys(employeeMap).length,
          data: enrichedData
        }
      }

      return {
        success: true,
        data: exportData,
        recordCount: enrichedData.length,
        format: format
      }

    } catch (error) {
      console.error('Error exporting attendance data:', error)
      return {
        success: false,
        message: `Export failed: ${error.message}`
      }
    }
  }

  convertToCSV(rows) {
    if (rows.length === 0) return ''

    const headers = Object.keys(rows[0])
    let csvContent = headers.join(',') + '\n'
    
    rows.forEach(row => {
      const values = headers.map(header => {
        let value = row[header]
        
        if (value === null || value === undefined) {
          value = ''
        }
        
        value = String(value).replace(/"/g, '""')
        
        if (value.includes(',') || value.includes('\n') || value.includes('"')) {
          value = `"${value}"`
        }
        
        return value
      })
      
      csvContent += values.join(',') + '\n'
    })

    return csvContent
  }

  async getExportStatistics(options = {}) {
    try {
      const db = getDatabase()
      const { startDate = null, endDate = null } = options

      let query = 'SELECT COUNT(*) as total, MIN(date) as earliest_date, MAX(date) as latest_date FROM attendance'
      const params = []
      const whereConditions = []

      if (startDate) {
        whereConditions.push('date >= ?')
        params.push(startDate)
      }

      if (endDate) {
        whereConditions.push('date <= ?')
        params.push(endDate)
      }

      if (whereConditions.length > 0) {
        query += ' WHERE ' + whereConditions.join(' AND ')
      }

      const stats = db.prepare(query).get(...params)

      // Get employee count
      const employees = Employee.getAll()

      return {
        success: true,
        statistics: {
          totalRecords: stats.total || 0,
          earliestDate: stats.earliest_date,
          latestDate: stats.latest_date,
          hasData: stats.total > 0,
          totalEmployees: employees.length,
          filters: {
            startDate: startDate || null,
            endDate: endDate || null
          }
        }
      }

    } catch (error) {
      console.error('Error getting export statistics:', error)
      return {
        success: false,
        message: `Failed to get statistics: ${error.message}`
      }
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, (error) => {
        if (error) {
          console.error('Failed to start export web server:', error)
          reject(error)
        } else {
          console.log(`🌐 Export web server running on http://localhost:${this.port}`)
          console.log(`📊 API Documentation: http://localhost:${this.port}/api/docs`)
          console.log(`📤 Export endpoint: http://localhost:${this.port}/export/data`)
          console.log(`👥 Employees endpoint: http://localhost:${this.port}/employees`)
          console.log(`👤 Single employee: http://localhost:${this.port}/employees/:idNumber`)
          resolve()
        }
      })
    })
  }

  stop() {
    if (this.server) {
      this.server.close()
      console.log('Export web server stopped')
    }
  }
}

module.exports = { WebExportServer }