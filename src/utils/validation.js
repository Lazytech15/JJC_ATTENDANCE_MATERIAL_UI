function validateEmployee(employee) {
  const errors = []

  if (!employee.uid) {
    errors.push("Employee UID is required")
  }

  if (!employee.first_name || employee.first_name.trim().length === 0) {
    errors.push("First name is required")
  }

  if (!employee.last_name || employee.last_name.trim().length === 0) {
    errors.push("Last name is required")
  }

  if (employee.email && !isValidEmail(employee.email)) {
    errors.push("Invalid email format")
  }

  return {
    isValid: errors.length === 0,
    errors: errors,
  }
}

function validateAttendance(attendance) {
  const errors = []

  if (!attendance.employee_uid) {
    errors.push("Employee UID is required")
  }

  if (
    !attendance.clock_type ||
    !["morning_in", "morning_out", "afternoon_in", "afternoon_out"].includes(attendance.clock_type)
  ) {
    errors.push("Invalid clock type")
  }

  if (!attendance.clock_time) {
    errors.push("Clock time is required")
  }

  return {
    isValid: errors.length === 0,
    errors: errors,
  }
}

function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email)
}

function sanitizeInput(input) {
  if (typeof input !== "string") {
    return input
  }

  return input.trim().replace(/[<>]/g, "")
}

module.exports = {
  validateEmployee,
  validateAttendance,
  isValidEmail,
  sanitizeInput,
}
