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
  const overtimeStart = 17 * 60 + 10 // 5:10 PM
  const overtimeGracePeriod = 5 // 5 minutes grace for overtime
  const regularGracePeriod = 5 // 5 minutes grace per hour for regular hours
  const overtimeSessionGracePeriod = 15 // 15 minutes grace for overtime sessions

  let regularHours = 0
  let overtimeHours = 0

  switch (clockType) {
    case "morning_in":
    case "afternoon_in":
    case "evening_in":
    case "overtime_in":
      regularHours = 0
      overtimeHours = 0
      break

    case "morning_out":
      if (clockInTime) {
        const result = calculateContinuousHours(clockInTime, clockTime, 'morning')
        regularHours = result.regularHours
        overtimeHours = result.overtimeHours
      }
      break

    case "afternoon_out":
      if (clockInTime) {
        const result = calculateContinuousHours(clockInTime, clockTime, 'afternoon')
        regularHours = result.regularHours
        overtimeHours = result.overtimeHours
      }
      break

    case "evening_out":
      if (clockInTime) {
        // Evening sessions are considered overtime sessions with 30-minute rule
        overtimeHours = calculateEveningSessionHours(clockInTime, clockTime, overtimeSessionGracePeriod)
      }
      break

    case "overtime_out":
      if (clockInTime) {
        overtimeHours = calculateOvertimeSessionHours(clockInTime, clockTime, overtimeSessionGracePeriod)
      }
      break
  }

  return {
    regularHours: Math.round(regularHours * 100) / 100,
    overtimeHours: Math.round(overtimeHours * 100) / 100,
  }
}

function calculateContinuousHours(clockInTime, clockOutTime, startingSession) {
  const clockInMinutes = clockInTime.getHours() * 60 + clockInTime.getMinutes()
  const clockOutMinutes = clockOutTime.getHours() * 60 + clockOutTime.getMinutes()
  
  // Working hours boundaries
  const morningStart = 8 * 60 // 8:00 AM
  const morningEnd = 12 * 60 // 12:00 PM
  const lunchStart = 12 * 60 // 12:00 PM (lunch break start)
  const lunchEnd = 13 * 60 // 1:00 PM (lunch break end)
  const afternoonStart = 13 * 60 // 1:00 PM
  const afternoonEnd = 17 * 60 // 5:00 PM
  const regularGracePeriod = 5 // 5 minutes grace per hour for regular hours
  
  let totalRegularHours = 0
  let totalOvertimeHours = 0

  console.log(`=== CONTINUOUS HOURS CALCULATION ===`)
  console.log(`Clock in: ${formatMinutes(clockInMinutes)} (${clockInMinutes} min)`)
  console.log(`Clock out: ${formatMinutes(clockOutMinutes)} (${clockOutMinutes} min)`)
  console.log(`Starting session: ${startingSession}`)

  // Handle different starting sessions
  if (startingSession === 'morning') {
    // Calculate morning hours (8:00-12:00)
    if (clockInMinutes < morningEnd && clockOutMinutes > morningStart) {
      const morningStartTime = Math.max(clockInMinutes, morningStart)
      const morningEndTime = Math.min(clockOutMinutes, morningEnd)
      
      if (morningEndTime > morningStartTime) {
        const morningHours = calculateRegularHours(
          new Date(0, 0, 0, Math.floor(morningStartTime / 60), morningStartTime % 60),
          new Date(0, 0, 0, Math.floor(morningEndTime / 60), morningEndTime % 60),
          morningStart,
          morningEnd,
          regularGracePeriod
        )
        totalRegularHours += morningHours
        console.log(`Morning hours (${formatMinutes(morningStartTime)} - ${formatMinutes(morningEndTime)}): ${morningHours}`)
      }
    }

    // Calculate afternoon hours (13:00-17:00) - only if clock out extends past lunch
    // FIXED: Only calculate afternoon hours if actually worked in afternoon period
    if (clockOutMinutes > afternoonStart) {
      const afternoonStartTime = afternoonStart // Always start at 13:00 for afternoon
      const afternoonEndTime = Math.min(clockOutMinutes, afternoonEnd)
      
      if (afternoonEndTime > afternoonStartTime) {
        // FIXED: Calculate actual worked hours in afternoon, not assuming full session
        const actualAfternoonMinutes = afternoonEndTime - afternoonStartTime
        
        // Use the same grace period logic as morning for consistency
        const afternoonHours = calculateRegularHours(
          new Date(0, 0, 0, Math.floor(afternoonStartTime / 60), afternoonStartTime % 60),
          new Date(0, 0, 0, Math.floor(afternoonEndTime / 60), afternoonEndTime % 60),
          afternoonStart,
          afternoonEnd,
          regularGracePeriod
        )
        totalRegularHours += afternoonHours
        console.log(`Afternoon hours (${formatMinutes(afternoonStartTime)} - ${formatMinutes(afternoonEndTime)}): ${afternoonHours}`)
        console.log(`Actual afternoon minutes worked: ${actualAfternoonMinutes}`)
      }

      // Calculate overtime hours (after 17:00)
      if (clockOutMinutes > afternoonEnd) {
        const overtimeHours = calculateSimpleOvertimeHours(
          afternoonEnd,
          clockOutMinutes
        )
        totalOvertimeHours += overtimeHours
        console.log(`Overtime hours (after ${formatMinutes(afternoonEnd)}): ${overtimeHours}`)
      }
    }

    // FIXED: Better lunch break logging
    if (clockInMinutes < lunchStart && clockOutMinutes > lunchEnd) {
      console.log(`Lunch break excluded: ${formatMinutes(lunchStart)} - ${formatMinutes(lunchEnd)} (1 hour)`)
    } else if (clockInMinutes < lunchStart && clockOutMinutes > lunchStart && clockOutMinutes <= lunchEnd) {
      console.log(`Clocked out during lunch break - no afternoon hours counted`)
    }
  } 
  else if (startingSession === 'afternoon') {
    // For afternoon sessions, if they clocked in during lunch (12:00-13:00), treat as 13:00
    let effectiveAfternoonClockIn = clockInMinutes
    if (clockInMinutes < afternoonStart) {
      effectiveAfternoonClockIn = afternoonStart // Lunch break - start counting from 13:00
      console.log(`Clock in during lunch break (${formatMinutes(clockInMinutes)}) - treating as 13:00 for calculation`)
    }
    
    // Calculate afternoon hours (13:00-17:00)
    if (effectiveAfternoonClockIn < afternoonEnd && clockOutMinutes > afternoonStart) {
      const afternoonStartTime = Math.max(effectiveAfternoonClockIn, afternoonStart)
      const afternoonEndTime = Math.min(clockOutMinutes, afternoonEnd)
      
      if (afternoonEndTime > afternoonStartTime) {
        const afternoonHours = calculateRegularHours(
          new Date(0, 0, 0, Math.floor(effectiveAfternoonClockIn / 60), effectiveAfternoonClockIn % 60),
          new Date(0, 0, 0, Math.floor(afternoonEndTime / 60), afternoonEndTime % 60),
          afternoonStart,
          afternoonEnd,
          regularGracePeriod
        )
        totalRegularHours += afternoonHours
        console.log(`Afternoon hours (${formatMinutes(afternoonStartTime)} - ${formatMinutes(afternoonEndTime)}): ${afternoonHours}`)
      }
    }

    // Calculate overtime hours (after 17:00)
    if (clockOutMinutes > afternoonEnd) {
      const overtimeHours = calculateSimpleOvertimeHours(
        afternoonEnd,
        clockOutMinutes
      )
      totalOvertimeHours += overtimeHours
      console.log(`Overtime hours (after ${formatMinutes(afternoonEnd)}): ${overtimeHours}`)
    }
  }

  console.log(`Total regular hours: ${totalRegularHours}`)
  console.log(`Total overtime hours: ${totalOvertimeHours}`)
  console.log(`=== END CONTINUOUS CALCULATION ===`)

  return {
    regularHours: totalRegularHours,
    overtimeHours: totalOvertimeHours
  }
}

// Simple overtime calculation for continuous work (no base hours, just time-based)
function calculateSimpleOvertimeHours(overtimeStartTime, clockOutMinutes) {
  const totalOvertimeMinutes = clockOutMinutes - overtimeStartTime
  
  if (totalOvertimeMinutes <= 0) {
    return 0
  }
  
  // Simple 30-minute rounding rule
  const wholeHours = Math.floor(totalOvertimeMinutes / 60)
  const remainingMinutes = totalOvertimeMinutes % 60
  
  let finalHours = wholeHours
  
  if (remainingMinutes >= 30) {
    finalHours += 0.5
  }
  // If remainingMinutes < 30, don't add anything
  
  console.log(`Simple overtime calculation:`)
  console.log(`- Overtime start: ${formatMinutes(overtimeStartTime)}`)
  console.log(`- Clock out: ${formatMinutes(clockOutMinutes)}`)
  console.log(`- Total overtime minutes: ${totalOvertimeMinutes}`)
  console.log(`- Whole hours: ${wholeHours}`)
  console.log(`- Remaining minutes: ${remainingMinutes}`)
  console.log(`- Final overtime hours: ${finalHours}`)
  
  return finalHours
}

function calculateRegularHours(clockInTime, clockOutTime, sessionStart, sessionEnd, gracePeriod) {
  const clockInMinutes = clockInTime.getHours() * 60 + clockInTime.getMinutes()
  const clockOutMinutes = clockOutTime.getHours() * 60 + clockOutTime.getMinutes()
  
  // FIXED: Don't add grace period to clock out time for regular hours calculation
  // The grace period should only apply to lateness, not extend work time
  const actualStartTime = Math.max(clockInMinutes, sessionStart)
  const actualEndTime = Math.min(clockOutMinutes, sessionEnd)
  
  if (actualEndTime <= actualStartTime) {
    return 0
  }

  // FIXED: Calculate hours based on actual time worked, respecting hour boundaries
  const totalMinutesWorked = actualEndTime - actualStartTime
  
  console.log(`Regular hours calculation:`)
  console.log(`- Session: ${formatMinutes(sessionStart)} - ${formatMinutes(sessionEnd)}`)
  console.log(`- Clock in: ${formatMinutes(clockInMinutes)} -> Effective: ${formatMinutes(actualStartTime)}`)
  console.log(`- Clock out: ${formatMinutes(clockOutMinutes)} -> Effective: ${formatMinutes(actualEndTime)}`)
  console.log(`- Minutes worked: ${totalMinutesWorked}`)

  const sessionDurationMinutes = sessionEnd - sessionStart
  const sessionHours = sessionDurationMinutes / 60
  
  let totalHours = 0
  
  // Process each hour in the session
  for (let hourIndex = 0; hourIndex < sessionHours; hourIndex++) {
    const hourStartTime = sessionStart + (hourIndex * 60)
    const hourEndTime = sessionStart + ((hourIndex + 1) * 60)
    
    // Check if this hour is worked at all
    if (actualEndTime <= hourStartTime || actualStartTime >= hourEndTime) {
      // Hour not worked at all
      console.log(`- Hour ${hourIndex + 1} (${formatMinutes(hourStartTime)}-${formatMinutes(hourEndTime)}): Not worked`)
      continue
    }
    
    // Calculate work time within this hour
    const hourWorkStart = Math.max(actualStartTime, hourStartTime)
    const hourWorkEnd = Math.min(actualEndTime, hourEndTime)
    const hourWorkMinutes = hourWorkEnd - hourWorkStart
    
    // FIXED: Calculate how late they were for this specific hour
    const lateForThisHour = Math.max(0, clockInMinutes - hourStartTime)
    
    console.log(`- Hour ${hourIndex + 1} (${formatMinutes(hourStartTime)}-${formatMinutes(hourEndTime)}):`)
    console.log(`  Work time: ${formatMinutes(hourWorkStart)}-${formatMinutes(hourWorkEnd)} (${hourWorkMinutes} min)`)
    console.log(`  Late by: ${lateForThisHour} minutes`)
    
    // FIXED: Only count hours if they actually worked a significant portion
    // OR if they were on time for the hour start
    if (lateForThisHour <= gracePeriod) {
      // They were on time for this hour - check if they worked enough
      if (hourWorkMinutes >= 30) {
        // Worked at least 30 minutes - give full hour
        totalHours += 1
        console.log(`  Result: 1 hour (on time and worked >= 30 min)`)
      } else if (hourWorkMinutes > 0) {
        // Worked less than 30 minutes - give half hour
        totalHours += 0.5
        console.log(`  Result: 0.5 hours (on time but worked < 30 min)`)
      }
    } else if (lateForThisHour > gracePeriod && lateForThisHour <= 30) {
      // 6-30 minutes late - only count if they worked at least 30 minutes
      if (hourWorkMinutes >= 30) {
        totalHours += 0.5
        console.log(`  Result: 0.5 hours (late 6-30 min but worked >= 30 min)`)
      } else {
        console.log(`  Result: 0 hours (late 6-30 min and worked < 30 min)`)
      }
    } else {
      // More than 30 minutes late
      console.log(`  Result: 0 hours (too late)`)
    }
  }
  
  console.log(`- Total regular hours: ${totalHours}`)
  return totalHours
}

function calculateOvertimeHours(regularEndTime, clockOutMinutes, overtimeStart, overtimeGracePeriod) {
  // Overtime starts at overtimeStart (17:10) with grace period
  const effectiveOvertimeStart = overtimeStart + overtimeGracePeriod // 17:15
  
  if (clockOutMinutes <= effectiveOvertimeStart) {
    return 0
  }
  
  return (clockOutMinutes - effectiveOvertimeStart) / 60
}

function calculateOvertimeSessionHours(clockInTime, clockOutTime, sessionGracePeriod) {
  const clockInMinutes = clockInTime.getHours() * 60 + clockInTime.getMinutes()
  const clockOutMinutes = clockOutTime.getHours() * 60 + clockOutTime.getMinutes()
  
  const totalMinutesWorked = clockOutMinutes - clockInMinutes
  
  // Apply 15-minute grace period for overtime sessions
  const effectiveMinutesWorked = Math.max(0, totalMinutesWorked - sessionGracePeriod)
  
  return effectiveMinutesWorked / 60
}

function calculateEveningSessionHours(clockInTime, clockOutTime, sessionGracePeriod) {
  const clockInMinutes = clockInTime.getHours() * 60 + clockInTime.getMinutes()
  const clockOutMinutes = clockOutTime.getHours() * 60 + clockOutTime.getMinutes()
  
  const totalMinutesWorked = clockOutMinutes - clockInMinutes
  
  // Evening session grace period logic:
  // - Clock in at exactly 17:15 (1035 minutes) = counts as 1 hour base
  // - Clock in at 17:16-17:30 (1036-1050 minutes) = counts as 0.5 hour base  
  // - Clock in at 17:31+ (1051+ minutes) = counts as 0 hour base
  
  const eveningStart = 17 * 60 + 15 // 17:15 (1035 minutes)
  const halfHourGrace = eveningStart + 15 // 17:30 (1050 minutes)
  
  let baseHours = 0
  
  if (clockInMinutes <= eveningStart) {
    // Clock in at or before 17:15 - full hour base
    baseHours = 1
  } else if (clockInMinutes <= halfHourGrace) {
    // Clock in between 17:16-17:30 - half hour base
    baseHours = 0.5
  } else {
    // Clock in after 17:30 - no base hours
    baseHours = 0
  }
  
  // Calculate additional hours beyond the first hour
  const effectiveMinutesWorked = Math.max(0, totalMinutesWorked - 60) // Subtract first hour
  let additionalHours = effectiveMinutesWorked / 60
  
  // Round additional hours to nearest 0.5 based on 30-minute rule
  if (additionalHours > 0) {
    const wholeHours = Math.floor(additionalHours)
    const remainingMinutes = effectiveMinutesWorked % 60
    
    if (remainingMinutes >= 30) {
      additionalHours = wholeHours + 1
    } else if (remainingMinutes > 0) {
      additionalHours = wholeHours + 0.5
    } else {
      additionalHours = wholeHours
    }
  }
  
  const totalHours = baseHours + additionalHours
  
  console.log(`Evening session calculation:`)
  console.log(`- Clock in: ${formatMinutes(clockInMinutes)}`)
  console.log(`- Clock out: ${formatMinutes(clockOutMinutes)}`)
  console.log(`- Total minutes worked: ${totalMinutesWorked}`)
  console.log(`- Base hours: ${baseHours}`)
  console.log(`- Additional hours: ${additionalHours}`)
  console.log(`- Total hours: ${totalHours}`)
  
  return totalHours
}

// Helper function to format minutes as HH:MM
function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`
}

function isLate(clockType, clockTime) {
  const hour = clockTime.getHours()
  const minute = clockTime.getMinutes()
  const totalMinutes = hour * 60 + minute

  const morningStart = 8 * 60 // 8:00 AM
  const afternoonStart = 13 * 60 // 1:00 PM
  const gracePeriod = 6 // 6 minutes

  console.log(`Late check: ${clockType} at ${hour}:${minute.toString().padStart(2, '0')} (${totalMinutes} minutes)`)

  if (clockType === "morning_in") {
    const isEmployeeLate = totalMinutes > morningStart + gracePeriod
    console.log(`Morning threshold: ${morningStart + gracePeriod} minutes (8:06 AM), Result: ${isEmployeeLate ? 'LATE' : 'ON TIME'}`)
    return isEmployeeLate
  } else if (clockType === "afternoon_in") {
    const isEmployeeLate = totalMinutes > afternoonStart + gracePeriod
    console.log(`Afternoon threshold: ${afternoonStart + gracePeriod} minutes (1:06 PM), Result: ${isEmployeeLate ? 'LATE' : 'ON TIME'}`)
    return isEmployeeLate
  }

  return false
}

function determineClockType(lastClockType, currentTime) {
  const safeCurrentTime = currentTime || new Date(dateService.getCurrentDateTime())
  const hour = safeCurrentTime.getHours()
  const minute = safeCurrentTime.getMinutes()
  const totalMinutes = hour * 60 + minute
  const eveningStart = 17 * 60 + 15 // 5:15 PM (after overtime grace period)
  
  // Define afternoon end time (5:00 PM)
  const afternoonEnd = 17 * 60 // 5:00 PM

  console.log(`=== CLOCK TYPE DETERMINATION ===`)
  console.log(`Input time: ${safeCurrentTime.toISOString()}`)
  console.log(`Parsed time: ${hour}:${minute.toString().padStart(2, '0')} (${totalMinutes} minutes from midnight)`)
  console.log(`Last clock type: ${lastClockType}`)
  console.log(`Evening start threshold: ${eveningStart} minutes (5:15 PM)`)
  console.log(`Afternoon end: ${afternoonEnd} minutes (5:00 PM)`)

  if (!lastClockType) {
    // First clock of the day
    console.log(`No previous clock - determining by time:`)
    
    if (totalMinutes >= eveningStart) {
      console.log(`Time >= 5:15 PM → evening_in`)
      return "evening_in" // Evening session (counts as overtime)
    }
    
    const clockType = hour < 12 ? "morning_in" : "afternoon_in"
    console.log(`Hour ${hour} < 12? ${hour < 12} → ${clockType}`)
    return clockType
  }

  console.log(`Processing sequence based on last clock: ${lastClockType}`)

  switch (lastClockType) {
    case "morning_in":
      console.log(`morning_in → morning_out`)
      return "morning_out"
    case "morning_out":
      console.log(`morning_out → afternoon_in (lunch break assumed)`)
      return "afternoon_in"
    case "afternoon_in":
      console.log(`afternoon_in → afternoon_out`)
      return "afternoon_out"
    case "afternoon_out":
      // FIXED: After afternoon_out, any clock in after 5:00 PM should be evening_in
      // This covers your case where they clock out at 17:02 and clock in at 17:13
      if (totalMinutes >= afternoonEnd) {
        console.log(`afternoon_out + time after 5:00 PM (${totalMinutes} >= ${afternoonEnd}) → evening_in`)
        return "evening_in"
      }
      // If it's before 5:00 PM after afternoon_out, it's likely the next day
      const nextClockType = hour < 12 ? "morning_in" : "afternoon_in"
      console.log(`afternoon_out + before 5:00 PM → ${nextClockType} (likely next day)`)
      return nextClockType
    case "evening_in":
      console.log(`evening_in → evening_out`)
      return "evening_out"
    case "evening_out":
      if (totalMinutes >= eveningStart) {
        console.log(`evening_out + still evening time → evening_in`)
        return "evening_in"
      }
      const nextAfterEvening = hour < 12 ? "morning_in" : "afternoon_in"
      console.log(`evening_out + not evening time → ${nextAfterEvening}`)
      return nextAfterEvening
    case "overtime_in":
      console.log(`overtime_in → overtime_out`)
      return "overtime_out"
    case "overtime_out":
      if (totalMinutes >= eveningStart) {
        console.log(`overtime_out + evening time → evening_in`)
        return "evening_in"
      }
      const nextAfterOvertime = hour < 12 ? "morning_in" : "afternoon_in"
      console.log(`overtime_out + not evening time → ${nextAfterOvertime}`)
      return nextAfterOvertime
    default:
      console.log(`Unknown last clock type: ${lastClockType} → defaulting to morning_in`)
      return "morning_in"
  }
}

module.exports = {
  calculateHours,
  determineClockType,
  isLate,
}