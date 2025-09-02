const dateService = require("./dateService")

function calculateHours(clockType, clockTime, clockInTime = null) {
  const hour = clockTime.getHours()
  const minute = clockTime.getMinutes()
  const totalMinutes = hour * 60 + minute

  // Working hours: 8:00-12:00 (morning) and 13:00-17:00 (afternoon)
  const morningStart = 8 * 60 // 8:00 AM
  const morningEnd = 12 * 60 // 12:00 PM
  const afternoonStart = 13 * 60 // 1:00 PM
  const afternoonEnd = 17 * 60 // 5:00 PM

  let regularHours = 0
  let overtimeHours = 0

  switch (clockType) {
    case "morning_in":
    case "afternoon_in":
      regularHours = 0
      overtimeHours = 0
      break

    case "morning_out":
      if (clockInTime) {
        const clockInMinutes = clockInTime.getHours() * 60 + clockInTime.getMinutes()
        const actualStartTime = Math.max(clockInMinutes, morningStart) // Can't start before 8:00
        const actualEndTime = Math.min(totalMinutes, morningEnd) // Can't work past 12:00 for regular hours

        if (actualEndTime > actualStartTime) {
          regularHours = (actualEndTime - actualStartTime) / 60
        }

        // Early morning overtime (before 8:00)
        if (clockInMinutes < morningStart) {
          overtimeHours = (morningStart - clockInMinutes) / 60
        }
      }
      break

    case "afternoon_out":
      if (clockInTime) {
        const clockInMinutes = clockInTime.getHours() * 60 + clockInTime.getMinutes()
        const actualStartTime = Math.max(clockInMinutes, afternoonStart) // Can't start before 13:00
        const actualEndTime = Math.min(totalMinutes, afternoonEnd) // Regular hours end at 17:00

        if (actualEndTime > actualStartTime) {
          regularHours = (actualEndTime - actualStartTime) / 60
        }

        // Overtime after 17:00
        if (totalMinutes > afternoonEnd && clockInMinutes < afternoonEnd) {
          const overtimeStart = Math.max(clockInMinutes, afternoonEnd)
          overtimeHours = (totalMinutes - overtimeStart) / 60
        }
      }
      break
  }

  return {
    regularHours: Math.round(regularHours * 100) / 100,
    overtimeHours: Math.round(overtimeHours * 100) / 100,
  }
}

function isLate(clockType, clockTime) {
  const hour = clockTime.getHours()
  const minute = clockTime.getMinutes()
  const totalMinutes = hour * 60 + minute

  const morningStart = 8 * 60 // 8:00 AM
  const afternoonStart = 13 * 60 // 1:00 PM
  const gracePeriod = 6 // 6 minutes

  if (clockType === "morning_in") {
    return totalMinutes > morningStart + gracePeriod
  } else if (clockType === "afternoon_in") {
    return totalMinutes > afternoonStart + gracePeriod
  }

  return false
}

function determineClockType(lastClockType, currentTime) {
  const safeCurrentTime = currentTime || new Date(dateService.getCurrentDateTime())
  const hour = safeCurrentTime.getHours()

  if (!lastClockType) {
    // First clock of the day
    return hour < 12 ? "morning_in" : "afternoon_in"
  }

  switch (lastClockType) {
    case "morning_in":
      return "morning_out"
    case "morning_out":
      return "afternoon_in"
    case "afternoon_in":
      return "afternoon_out"
    case "afternoon_out":
      // New cycle - determine based on time
      return hour < 12 ? "morning_in" : "afternoon_in"
    default:
      return "morning_in"
  }
}

module.exports = {
  calculateHours,
  determineClockType,
  isLate, // Exported isLate function
}
