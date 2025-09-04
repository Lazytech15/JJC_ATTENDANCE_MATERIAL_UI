// api/routes/export.js
const { getDatabase } = require('../../database/setup')
const fs = require('fs').promises
const path = require('path')
const { app } = require('electron')

/**
 * Export all attendance data to CSV format
 * @param {Event} event - IPC event object
 * @param {Object} options - Export options (format, dateRange, etc.)
 * @returns {Object} Export result with file path and record count
 */
async function exportAttendanceData(event, options = {}) {
  try {
    const db = getDatabase()
    const { 
      format = 'csv', 
      startDate = null, 
      endDate = null,
      includeEmployeeDetails = true 
    } = options

    // Build the query based on options
    let query = `
      SELECT 
        a.*,
        ${includeEmployeeDetails ? `
        e.name as employee_name,
        e.department,
        e.position,
        e.email
        ` : 'NULL as employee_name, NULL as department, NULL as position, NULL as email'}
      FROM attendance a
      ${includeEmployeeDetails ? 'LEFT JOIN employees e ON a.employee_uid = e.uid' : ''}
    `
    
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

    console.log('Executing export query:', query)
    console.log('With parameters:', params)

    // Execute the query
    const rows = db.prepare(query).all(...params)
    
    if (rows.length === 0) {
      return {
        success: false,
        message: 'No data found for the specified criteria',
        recordCount: 0
      }
    }

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `attendance_export_${timestamp}.${format}`
    
    // Get app data path for exports
    const exportDir = path.join(app.getPath('userData'), 'exports')
    
    // Ensure export directory exists
    try {
      await fs.mkdir(exportDir, { recursive: true })
    } catch (error) {
      console.log('Export directory already exists or created successfully')
    }

    const filePath = path.join(exportDir, filename)

    // Export based on format
    if (format === 'csv') {
      await exportToCSV(rows, filePath)
    } else if (format === 'json') {
      await exportToJSON(rows, filePath)
    } else {
      throw new Error(`Unsupported export format: ${format}`)
    }

    return {
      success: true,
      message: `Successfully exported ${rows.length} records`,
      filePath: filePath,
      filename: filename,
      recordCount: rows.length,
      format: format
    }

  } catch (error) {
    console.error('Error exporting attendance data:', error)
    return {
      success: false,
      message: `Export failed: ${error.message}`,
      error: error.message
    }
  }
}

/**
 * Export data to CSV format
 */
async function exportToCSV(rows, filePath) {
  if (rows.length === 0) return

  // Get headers from the first row
  const headers = Object.keys(rows[0])
  
  // Create CSV content
  let csvContent = headers.join(',') + '\n'
  
  rows.forEach(row => {
    const values = headers.map(header => {
      let value = row[header]
      
      // Handle null/undefined values
      if (value === null || value === undefined) {
        value = ''
      }
      
      // Convert to string and escape quotes
      value = String(value).replace(/"/g, '""')
      
      // Wrap in quotes if contains comma, newline, or quote
      if (value.includes(',') || value.includes('\n') || value.includes('"')) {
        value = `"${value}"`
      }
      
      return value
    })
    
    csvContent += values.join(',') + '\n'
  })

  await fs.writeFile(filePath, csvContent, 'utf8')
}

/**
 * Export data to JSON format
 */
async function exportToJSON(rows, filePath) {
  const jsonData = {
    exportDate: new Date().toISOString(),
    recordCount: rows.length,
    data: rows
  }

  await fs.writeFile(filePath, JSON.stringify(jsonData, null, 2), 'utf8')
}

/**
 * Get available export formats
 */
async function getExportFormats() {
  return {
    success: true,
    formats: [
      { value: 'csv', label: 'CSV (Comma Separated Values)', extension: '.csv' },
      { value: 'json', label: 'JSON (JavaScript Object Notation)', extension: '.json' }
    ]
  }
}

/**
 * Get export statistics (total records, date range, etc.)
 */
async function getExportStatistics(event, options = {}) {
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

    return {
      success: true,
      statistics: {
        totalRecords: stats.total || 0,
        earliestDate: stats.earliest_date,
        latestDate: stats.latest_date,
        hasData: stats.total > 0
      }
    }

  } catch (error) {
    console.error('Error getting export statistics:', error)
    return {
      success: false,
      message: `Failed to get statistics: ${error.message}`,
      error: error.message
    }
  }
}

module.exports = {
  exportAttendanceData,
  getExportFormats,
  getExportStatistics
}