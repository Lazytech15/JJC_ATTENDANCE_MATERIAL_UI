const { getDatabase } = require("../database/setup")

/**
 * Remove duplicate attendance records
 * Keeps the earliest record for each employee-date-clock_type combination
 */
function removeDuplicateAttendanceRecords() {
  const db = getDatabase()
  
  console.log('=== REMOVING DUPLICATE ATTENDANCE RECORDS ===')
  
  try {
    // Start transaction
    db.exec('BEGIN TRANSACTION')
    
    // Find duplicates
    const duplicatesQuery = db.prepare(`
      SELECT 
        employee_uid,
        date,
        clock_type,
        COUNT(*) as count,
        GROUP_CONCAT(id) as ids
      FROM attendance
      GROUP BY employee_uid, date, clock_type
      HAVING count > 1
      ORDER BY employee_uid, date, clock_type
    `)
    
    const duplicates = duplicatesQuery.all()
    
    console.log(`Found ${duplicates.length} sets of duplicate records`)
    
    let totalDeleted = 0
    
    // For each set of duplicates, keep the first one and delete the rest
    for (const dup of duplicates) {
      const ids = dup.ids.split(',').map(id => parseInt(id))
      const keepId = Math.min(...ids) // Keep the earliest ID
      const deleteIds = ids.filter(id => id !== keepId)
      
      console.log(`\nEmployee ${dup.employee_uid} - ${dup.date} - ${dup.clock_type}:`)
      console.log(`  Found ${dup.count} duplicates (IDs: ${ids.join(', ')})`)
      console.log(`  Keeping ID ${keepId}, deleting ${deleteIds.length} duplicates`)
      
      // Delete the duplicate records
      const deleteStmt = db.prepare(`
        DELETE FROM attendance 
        WHERE id IN (${deleteIds.map(() => '?').join(',')})
      `)
      
      const result = deleteStmt.run(...deleteIds)
      totalDeleted += result.changes
      
      console.log(`  Deleted ${result.changes} records`)
    }
    
    // Commit transaction
    db.exec('COMMIT')
    
    console.log(`\n=== CLEANUP COMPLETE ===`)
    console.log(`Total duplicate records removed: ${totalDeleted}`)
    
    return {
      duplicateSetsFound: duplicates.length,
      recordsDeleted: totalDeleted
    }
    
  } catch (error) {
    // Rollback on error
    db.exec('ROLLBACK')
    console.error('Error removing duplicates:', error)
    throw error
  }
}

/**
 * Preview duplicates without deleting
 */
function previewDuplicates() {
  const db = getDatabase()
  
  console.log('=== PREVIEWING DUPLICATE RECORDS ===')
  
  const duplicatesQuery = db.prepare(`
    SELECT 
      employee_uid,
      date,
      clock_type,
      COUNT(*) as count
    FROM attendance
    GROUP BY employee_uid, date, clock_type
    HAVING count > 1
    ORDER BY count DESC, employee_uid, date
  `)
  
  const duplicates = duplicatesQuery.all()
  
  console.log(`\nFound ${duplicates.length} sets of duplicates:\n`)
  
  duplicates.forEach((dup, index) => {
    console.log(`${index + 1}. Employee ${dup.employee_uid} - ${dup.date} - ${dup.clock_type}: ${dup.count} records`)
  })
  
  const totalDuplicates = duplicates.reduce((sum, dup) => sum + (dup.count - 1), 0)
  console.log(`\nTotal duplicate records to remove: ${totalDuplicates}`)
  
  return duplicates
}

module.exports = {
  removeDuplicateAttendanceRecords,
  previewDuplicates
}