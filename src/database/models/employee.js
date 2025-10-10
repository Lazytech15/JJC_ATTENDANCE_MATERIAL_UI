const { getDatabase } = require("../setup")

class Employee {
  static getAll() {
    const db = getDatabase()
    const stmt = db.prepare("SELECT * FROM employees WHERE status = ? ORDER BY first_name, last_name")
    return stmt.all("Active")
  }

  static findByIdNumber(idNumber) {
    const db = getDatabase()
    const stmt = db.prepare("SELECT * FROM employees WHERE id_number = ? AND status = ?")
    return stmt.get(idNumber, "Active")
  }

  static findByBarcode(barcode) {
    const db = getDatabase()
    const stmt = db.prepare("SELECT * FROM employees WHERE id_barcode = ? AND status = ?")
    return stmt.get(barcode, "Active")
  }

  static findByUid(uid) {
    const db = getDatabase()
    const stmt = db.prepare("SELECT * FROM employees WHERE uid = ?")
    return stmt.get(uid)
  }

  static insertMany(employees) {
    const db = getDatabase()
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO employees 
      (uid, id_number, id_barcode, first_name, middle_name, last_name, email, department, status, profile_picture, face_descriptor, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `)

    const transaction = db.transaction((employees) => {
      for (const emp of employees) {
        stmt.run(
          emp.uid,
          emp.id_number,
          emp.id_barcode,
          emp.first_name,
          emp.middle_name,
          emp.last_name,
          emp.email,
          emp.department,
          emp.status || "Active",
          emp.profile_picture,
          emp.face_descriptor,
        )
      }
    })

    return transaction(employees)
  }

  static getCount() {
    const db = getDatabase()
    const stmt = db.prepare("SELECT COUNT(*) as count FROM employees WHERE status = ?")
    return stmt.get("Active").count
  }
}

module.exports = Employee
