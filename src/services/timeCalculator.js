const dateService = require("./dateService")

function calculateHours(clockType, clockTime, clockInTime = null) {

  const overtimeSessionGracePeriod = 15 // 15 minutes grace for overtime sessions

  let regularHours = 0
  let overtimeHours = 0

  console.log(`=== CALCULATE HOURS ===`)
  console.log(`Clock type: ${clockType}`)
  console.log(`Clock out time: ${clockTime}`)
  console.log(`Clock in time: ${clockInTime}`)

  switch (clockType) {
    case "morning_in":
    case "afternoon_in":
    case "evening_in":
    case "overtime_in":
      console.log(`Clock-in type: ${clockType} - no hours to calculate`)
      regularHours = 0
      overtimeHours = 0
      break

    case "morning_out":
      if (clockInTime) {
        console.log(`Processing morning_out with continuous hours calculation`)
        const result = calculateContinuousHours(clockInTime, clockTime, 'morning')
        regularHours = result.regularHours
        overtimeHours = result.overtimeHours
        console.log(`Morning session result: Regular=${regularHours}, Overtime=${overtimeHours}`)
      } else {
        console.log(`WARNING: morning_out without clockInTime`)
      }
      break

    case "afternoon_out":
      if (clockInTime) {
        console.log(`Processing afternoon_out with continuous hours calculation`)
        const result = calculateContinuousHours(clockInTime, clockTime, 'afternoon')
        regularHours = result.regularHours
        overtimeHours = result.overtimeHours
        console.log(`Afternoon session result: Regular=${regularHours}, Overtime=${overtimeHours}`)
      } else {
        console.log(`WARNING: afternoon_out without clockInTime`)
      }
      break

    case "evening_out":
      if (clockInTime) {
        console.log(`Processing evening_out with session hours calculation`)
        // Evening sessions are considered overtime sessions with grace period rules
        overtimeHours = calculateEveningSessionHours(clockInTime, clockTime, overtimeSessionGracePeriod)
        console.log(`Evening session result: Overtime=${overtimeHours}`)
      } else {
        console.log(`WARNING: evening_out without clockInTime`)
      }
      break

    case "overtime_out":
      if (clockInTime) {
        console.log(`Processing overtime_out with session hours calculation`)
        overtimeHours = calculateOvertimeSessionHours(clockInTime, clockTime, overtimeSessionGracePeriod)
        console.log(`Overtime session result: Overtime=${overtimeHours}`)
      } else {
        console.log(`WARNING: overtime_out without clockInTime`)
      }
      break

    default:
      console.log(`Unknown clock type: ${clockType}`)
      break
  }

  const finalResult = {
    regularHours: Math.round(regularHours * 100) / 100,
    overtimeHours: Math.round(overtimeHours * 100) / 100,
  }

  console.log(`=== FINAL CALCULATION RESULT ===`)
  console.log(`Regular Hours: ${finalResult.regularHours}`)
  console.log(`Overtime Hours: ${finalResult.overtimeHours}`)
  console.log(`Total Hours: ${finalResult.regularHours + finalResult.overtimeHours}`)

  return finalResult
}

function calculateContinuousHours(clockInTime, clockOutTime, startingSession) {
  let clockInMinutes = clockInTime.getHours() * 60 + clockInTime.getMinutes()
  let clockOutMinutes = clockOutTime.getHours() * 60 + clockOutTime.getMinutes()
  
  // Handle overnight shifts - if clock out is earlier in the day than clock in, add 24 hours
  if (clockOutMinutes < clockInMinutes) {
    clockOutMinutes += 24 * 60 // Add 24 hours worth of minutes
    console.log(`Detected overnight shift - adjusted clock out to: ${formatMinutes(clockOutMinutes)} (next day)`)
  }
  
  // Working hours boundaries
  const earlyMorningStart = 6 * 60 // 6:00 AM - new early morning boundary
  const morningStart = 8 * 60 // 8:00 AM
  const morningEnd = 12 * 60 // 12:00 PM
  const lunchStart = 12 * 60 // 12:00 PM (lunch break start)
  const lunchEnd = 13 * 60 // 1:00 PM (lunch break end)
  const afternoonStart = 13 * 60 // 1:00 PM
  const afternoonEnd = 17 * 60 // 5:00 PM
  const overtimeEnd = 22 * 60 // 10:00 PM (end of regular overtime)
  const nightShiftEnd = (6 * 60) + (24 * 60) // 6:00 AM next day
  const regularGracePeriod = 5 // 5 minutes grace per hour for regular hours
  const earlyMorningGracePeriod = 5 // 5 minutes grace for early morning overtime
  
  let totalRegularHours = 0
  let totalOvertimeHours = 0

  console.log(`=== CONTINUOUS HOURS CALCULATION ===`)
  console.log(`Clock in: ${formatMinutes(clockInMinutes)} (${clockInMinutes} min)`)
  console.log(`Clock out: ${formatMinutes(clockOutMinutes)} (${clockOutMinutes} min)`)
  console.log(`Starting session: ${startingSession}`)

  // Check for NEW EARLY MORNING RULE (6:00-12:00)
  // Rule applies if: morning session + clock in between 5:55-12:00 + clock out by 12:00
  const earlyMorningGraceStart = earlyMorningStart - earlyMorningGracePeriod // 5:55 AM
  
  if (startingSession === 'morning' && 
      clockInMinutes >= earlyMorningGraceStart && 
      clockInMinutes < morningStart && // Must be before 8:00 AM to qualify
      clockOutMinutes >= morningEnd - 30) { // Must work close to 12:00 (within 30 min)
    
    console.log(`=== EARLY MORNING RULE APPLIED (6:00-12:00) ===`)
    console.log(`Clock in: ${formatMinutes(clockInMinutes)} (grace period allows 5:55-8:00)`)
    console.log(`Clock out: ${formatMinutes(clockOutMinutes)} (should be close to 12:00)`)
    console.log(`Special rule: 6 total hours (4 regular + 2 overtime) for early morning shift`)
    
    // Check if they qualify for the early morning rule (with grace period)
    if (clockInMinutes <= earlyMorningStart + earlyMorningGracePeriod) { // Allow up to 6:05
      // Fixed allocation: 4 regular hours + 2 overtime hours = 6 total hours
      totalRegularHours = 4
      totalOvertimeHours = 2
      
      console.log(`Clock in within grace period (${formatMinutes(clockInMinutes)} <= 6:05)`)
      console.log(`Fixed allocation applied: ${totalRegularHours} regular + ${totalOvertimeHours} overtime = 6 total hours`)
      
      console.log(`Early morning rule result: Regular=${totalRegularHours}, Overtime=${totalOvertimeHours}`)
      console.log(`=== END EARLY MORNING RULE ===`)
      
      return {
        regularHours: totalRegularHours,
        overtimeHours: totalOvertimeHours
      }
    } else {
      // Late for early morning shift - calculate normally but still within early morning timeframe
      console.log(`Clock in too late for early morning rule (${formatMinutes(clockInMinutes)} > 6:05)`)
      console.log(`Falling back to normal calculation...`)
    }
    
    console.log(`=== END EARLY MORNING RULE (continuing to normal calculation) ===`)
  }

  // Handle different starting sessions (existing logic continues for other cases)
  if (startingSession === 'morning') {
    // Check for early arrival overtime (before 8:00 AM, but not in the special 6:00-12:00 range)
    if (clockInMinutes < morningStart && !(clockInMinutes >= earlyMorningStart && clockOutMinutes <= morningEnd)) {
      const earlyArrivalEnd = Math.min(clockOutMinutes, morningStart)
      if (earlyArrivalEnd > clockInMinutes) {
        const earlyOvertimeHours = calculateSimpleOvertimeHours(clockInMinutes, earlyArrivalEnd)
        totalOvertimeHours += earlyOvertimeHours
        console.log(`Early arrival overtime (${formatMinutes(clockInMinutes)} - ${formatMinutes(earlyArrivalEnd)}): ${earlyOvertimeHours} hours`)
      }
    }

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
    if (clockOutMinutes > afternoonStart) {
      const afternoonStartTime = afternoonStart // Always start at 13:00 for afternoon
      const afternoonEndTime = Math.min(clockOutMinutes, afternoonEnd)
      
      if (afternoonEndTime > afternoonStartTime) {
        const afternoonHours = calculateRegularHours(
          new Date(0, 0, 0, Math.floor(afternoonStartTime / 60), afternoonStartTime % 60),
          new Date(0, 0, 0, Math.floor(afternoonEndTime / 60), afternoonEndTime % 60),
          afternoonStart,
          afternoonEnd,
          regularGracePeriod
        )
        totalRegularHours += afternoonHours
        console.log(`Afternoon hours (${formatMinutes(afternoonStartTime)} - ${formatMinutes(afternoonEndTime)}): ${afternoonHours}`)
      }
    }

    // Calculate regular overtime hours (17:00-22:00)
    if (clockOutMinutes > afternoonEnd) {
      const regularOvertimeStart = afternoonEnd
      const regularOvertimeEnd = Math.min(clockOutMinutes, overtimeEnd)
      
      if (regularOvertimeEnd > regularOvertimeStart) {
        const regularOvertimeHours = calculateSimpleOvertimeHours(regularOvertimeStart, regularOvertimeEnd)
        totalOvertimeHours += regularOvertimeHours
        console.log(`Regular overtime hours (${formatMinutes(regularOvertimeStart)} - ${formatMinutes(regularOvertimeEnd)}): ${regularOvertimeHours}`)
      }
    }

    // Calculate night shift overtime hours (22:00-06:00 next day)
    if (clockOutMinutes > overtimeEnd) {
      const nightShiftStart = overtimeEnd
      const nightShiftEndTime = Math.min(clockOutMinutes, nightShiftEnd)
      
      if (nightShiftEndTime > nightShiftStart) {
        const nightShiftHours = calculateSimpleOvertimeHours(nightShiftStart, nightShiftEndTime)
        totalOvertimeHours += nightShiftHours
        console.log(`Night shift overtime hours (${formatMinutes(nightShiftStart)} - ${formatMinutes(nightShiftEndTime)}): ${nightShiftHours}`)
      }
    }

    // Handle lunch break logging
    if (clockInMinutes < lunchStart && clockOutMinutes > lunchEnd) {
      console.log(`Lunch break excluded: ${formatMinutes(lunchStart)} - ${formatMinutes(lunchEnd)} (1 hour)`)
    } else if (clockInMinutes < lunchStart && clockOutMinutes > lunchStart && clockOutMinutes <= lunchEnd) {
      console.log(`Clocked out during lunch break - no afternoon hours counted`)
    }
  } 
  else if (startingSession === 'afternoon') {
    // For afternoon sessions, if they clocked in during lunch (12:00-13:00), treat as 13:00
    let effectiveAfternoonClockIn = clockInMinutes
    if (clockInMinutes < afternoonStart && clockInMinutes >= lunchStart) {
      effectiveAfternoonClockIn = afternoonStart // Lunch break - start counting from 13:00
      console.log(`Clock in during lunch break (${formatMinutes(clockInMinutes)}) - treating as 13:00 for calculation`)
    }
    
    // Check for early afternoon arrival (before 13:00, but not during lunch)
    if (clockInMinutes < lunchStart) {
      // This is very early afternoon clock-in (before 12:00) - count as early arrival overtime
      const earlyAfternoonEnd = Math.min(clockOutMinutes, afternoonStart)
      if (earlyAfternoonEnd > clockInMinutes) {
        const earlyAfternoonOvertime = calculateSimpleOvertimeHours(clockInMinutes, earlyAfternoonEnd)
        totalOvertimeHours += earlyAfternoonOvertime
        console.log(`Early afternoon arrival overtime (${formatMinutes(clockInMinutes)} - ${formatMinutes(earlyAfternoonEnd)}): ${earlyAfternoonOvertime} hours`)
      }
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

    // Calculate regular overtime hours (17:00-22:00)
    if (clockOutMinutes > afternoonEnd) {
      const regularOvertimeStart = afternoonEnd
      const regularOvertimeEnd = Math.min(clockOutMinutes, overtimeEnd)
      
      if (regularOvertimeEnd > regularOvertimeStart) {
        const regularOvertimeHours = calculateSimpleOvertimeHours(regularOvertimeStart, regularOvertimeEnd)
        totalOvertimeHours += regularOvertimeHours
        console.log(`Regular overtime hours (${formatMinutes(regularOvertimeStart)} - ${formatMinutes(regularOvertimeEnd)}): ${regularOvertimeHours}`)
      }
    }

    // Calculate night shift overtime hours (22:00-06:00 next day)
    if (clockOutMinutes > overtimeEnd) {
      const nightShiftStart = overtimeEnd
      const nightShiftEndTime = Math.min(clockOutMinutes, nightShiftEnd)
      
      if (nightShiftEndTime > nightShiftStart) {
        const nightShiftHours = calculateSimpleOvertimeHours(nightShiftStart, nightShiftEndTime)
        totalOvertimeHours += nightShiftHours
        console.log(`Night shift overtime hours (${formatMinutes(nightShiftStart)} - ${formatMinutes(nightShiftEndTime)}): ${nightShiftHours}`)
      }
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

function calculateSimpleOvertimeHours(overtimeStartTime, clockOutMinutes) {
  const totalOvertimeMinutes = clockOutMinutes - overtimeStartTime
  
  console.log(`=== SIMPLE OVERTIME CALCULATION DEBUG ===`)
  console.log(`Overtime start: ${formatMinutes(overtimeStartTime)} (${overtimeStartTime} min)`)
  console.log(`Clock out: ${formatMinutes(clockOutMinutes)} (${clockOutMinutes} min)`)
  console.log(`Total overtime minutes: ${totalOvertimeMinutes}`)
  
  if (totalOvertimeMinutes <= 0) {
    console.log(`No overtime minutes - returning 0`)
    return 0
  }
  
  // Convert minutes to hours with 30-minute rounding
  const exactHours = totalOvertimeMinutes / 60
  const wholeHours = Math.floor(exactHours)
  const remainingMinutes = totalOvertimeMinutes % 60
  
  console.log(`Exact hours: ${exactHours}`)
  console.log(`Whole hours: ${wholeHours}`)
  console.log(`Remaining minutes: ${remainingMinutes}`)
  
  let finalHours = wholeHours
  
  if (remainingMinutes >= 30) {
    finalHours += 0.5
    console.log(`Added 0.5 hours for ${remainingMinutes} remaining minutes`)
  } else if (remainingMinutes > 0) {
    console.log(`${remainingMinutes} remaining minutes < 30 - no addition`)
  }
  
  console.log(`Final overtime hours: ${finalHours}`)
  console.log(`=== END SIMPLE OVERTIME CALCULATION ===`)
  
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
  let clockInMinutes = clockInTime.getHours() * 60 + clockInTime.getMinutes()
  let clockOutMinutes = clockOutTime.getHours() * 60 + clockOutTime.getMinutes()
  
  // Handle overnight shifts - if clock out is earlier in the day than clock in, add 24 hours
  if (clockOutMinutes < clockInMinutes) {
    clockOutMinutes += 24 * 60 // Add 24 hours worth of minutes
    console.log(`Detected overnight shift - adjusted clock out to: ${formatMinutes(clockOutMinutes)} (next day)`)
  }
  
  const totalMinutesWorked = clockOutMinutes - clockInMinutes
  
  // Apply 15-minute grace period for overtime sessions
  const effectiveMinutesWorked = Math.max(0, totalMinutesWorked - sessionGracePeriod)
  
  console.log(`Overtime session calculation:`)
  console.log(`- Clock in: ${formatMinutes(clockInMinutes)}`)
  console.log(`- Clock out: ${formatMinutes(clockOutMinutes)}`)
  console.log(`- Total minutes worked: ${totalMinutesWorked}`)
  console.log(`- Grace period applied: ${sessionGracePeriod} minutes`)
  console.log(`- Effective minutes worked: ${effectiveMinutesWorked}`)
  
  return effectiveMinutesWorked / 60
}

// Fixed version - replace your existing calculateEveningSessionHours function with this
function calculateEveningSessionHours(clockInTime, clockOutTime, sessionGracePeriod) {
  let clockInMinutes = clockInTime.getHours() * 60 + clockInTime.getMinutes()
  let clockOutMinutes = clockOutTime.getHours() * 60 + clockOutTime.getMinutes()
  
  console.log(`Evening session calculation - INITIAL:`)
  console.log(`- Clock in: ${formatMinutes(clockInMinutes)} (${clockInMinutes} minutes)`)
  console.log(`- Clock out: ${formatMinutes(clockOutMinutes)} (${clockOutMinutes} minutes)`)
  
  // CRITICAL FIX: Handle overnight shifts BEFORE calculating total minutes
  if (clockOutMinutes < clockInMinutes) {
    clockOutMinutes += 24 * 60 // Add 24 hours worth of minutes
    console.log(`- OVERNIGHT DETECTED: Adjusted clock out to: ${formatMinutes(clockOutMinutes)} (${clockOutMinutes} minutes)`)
  }
  
  const totalMinutesWorked = clockOutMinutes - clockInMinutes
  console.log(`- CALCULATED: Total minutes worked = ${clockOutMinutes} - ${clockInMinutes} = ${totalMinutesWorked}`)
  
  // Evening session time boundaries
  const eveningStart = 17 * 60 // 17:00 (1020 minutes)
  const eveningGraceEnd = eveningStart + sessionGracePeriod // 17:15 (1035 minutes)
  const firstHourEnd = eveningStart + 60 // 18:00 (1080 minutes)
  
  console.log(`- Evening start: ${formatMinutes(eveningStart)} (17:00)`)
  console.log(`- Grace period end: ${formatMinutes(eveningGraceEnd)} (17:15)`)
  console.log(`- First hour end: ${formatMinutes(firstHourEnd)} (18:00)`)
  
  if (totalMinutesWorked <= 0) {
    console.log(`- Result: 0 hours (no time worked - ${totalMinutesWorked} minutes)`)
    return 0
  }
  
  let totalHours = 0
  
  // For evening sessions that start very late (22:00 or later), treat as continuous overtime
  const lateEveningStart = 22 * 60 // 22:00 (10:00 PM)
  
  if (clockInMinutes >= lateEveningStart) {
    console.log(`- LATE EVENING SHIFT: Clock in >= 22:00 - calculating as continuous overtime`)
    
    // Apply grace period to total time worked
    const effectiveMinutesWorked = Math.max(0, totalMinutesWorked - sessionGracePeriod)
    
    console.log(`- Total minutes worked: ${totalMinutesWorked}`)
    console.log(`- Grace period applied: ${sessionGracePeriod} minutes`)
    console.log(`- Effective minutes worked: ${effectiveMinutesWorked}`)
    
    // Convert to hours with 30-minute rounding
    const exactHours = effectiveMinutesWorked / 60
    const wholeHours = Math.floor(exactHours)
    const remainingMinutes = effectiveMinutesWorked % 60
    
    totalHours = wholeHours
    
    if (remainingMinutes >= 30) {
      totalHours += 0.5
      console.log(`- Added 0.5 hours for ${remainingMinutes} remaining minutes`)
    } else if (remainingMinutes > 0) {
      console.log(`- ${remainingMinutes} remaining minutes < 30 - no addition`)
    }
    
    console.log(`- FINAL LATE EVENING RESULT: ${totalHours} hours`)
    return totalHours
  }
  
  // Original logic for regular evening sessions (17:00-22:00 clock ins)
  console.log(`- REGULAR EVENING SESSION: Using hourly calculation`)
  
  // Calculate first hour (17:00-18:00) with special grace period rule
  let firstHourCredit = 0
  
  if (clockInMinutes <= eveningGraceEnd) {
    // On time - gets full first hour credit
    firstHourCredit = 1
    console.log(`- Clock in <= 17:15 (grace period) → First hour credit: 1.0`)
  } else if (clockInMinutes < firstHourEnd) {
    // Late but within first hour - gets half credit
    firstHourCredit = 0.5
    console.log(`- Clock in 17:16-17:59 (late but within first hour) → First hour credit: 0.5`)
  } else {
    // Clocked in after 18:00 - no first hour credit
    firstHourCredit = 0
    console.log(`- Clock in >= 18:00 (missed first hour) → First hour credit: 0`)
  }
  
  totalHours += firstHourCredit
  
  // Calculate remaining hours after 18:00
  if (clockOutMinutes > firstHourEnd) {
    const remainingStart = Math.max(clockInMinutes, firstHourEnd)
    const remainingMinutes = clockOutMinutes - remainingStart
    
    console.log(`- Remaining time after 18:00: ${remainingMinutes} minutes`)
    
    if (remainingMinutes > 0) {
      // Convert remaining minutes to hours with 30-minute rounding
      const exactRemainingHours = remainingMinutes / 60
      const wholeRemainingHours = Math.floor(exactRemainingHours)
      const remainingFraction = remainingMinutes % 60
      
      let additionalHours = wholeRemainingHours
      
      if (remainingFraction >= 30) {
        additionalHours += 0.5
        console.log(`- Remaining: ${wholeRemainingHours} whole hours + 0.5 for ${remainingFraction} minutes`)
      } else if (remainingFraction > 0) {
        console.log(`- Remaining: ${wholeRemainingHours} whole hours (${remainingFraction} minutes < 30, no addition)`)
      }
      
      totalHours += additionalHours
      console.log(`- Additional hours after 18:00: ${additionalHours}`)
    }
  }
  
  console.log(`- FINAL CALCULATION: First hour (${firstHourCredit}) + Additional = ${totalHours}`)
  return totalHours
}

// Fixed version - replace your existing calculateEveningSessionHoursWithStats function with this
function calculateEveningSessionHoursWithStats(clockInTime, clockOutTime, sessionGracePeriod, statisticsData) {
  let clockInMinutes = clockInTime.getHours() * 60 + clockInTime.getMinutes()
  let clockOutMinutes = clockOutTime.getHours() * 60 + clockOutTime.getMinutes()
  
  console.log(`Evening session calculation with stats - INITIAL:`)
  console.log(`- Clock in: ${formatMinutes(clockInMinutes)} (${clockInMinutes} minutes)`)
  console.log(`- Clock out: ${formatMinutes(clockOutMinutes)} (${clockOutMinutes} minutes)`)
  
  // CRITICAL FIX: Handle overnight shifts BEFORE calculating total minutes
  if (clockOutMinutes < clockInMinutes) {
    clockOutMinutes += 24 * 60 // Add 24 hours worth of minutes
    statisticsData.overnightShift = true
    console.log(`- OVERNIGHT DETECTED: Adjusted clock out to: ${formatMinutes(clockOutMinutes)} (${clockOutMinutes} minutes)`)
  }
  
  const totalMinutesWorked = clockOutMinutes - clockInMinutes
  console.log(`- CALCULATED: Total minutes worked = ${clockOutMinutes} - ${clockInMinutes} = ${totalMinutesWorked}`)
  
  // Evening session time boundaries
  const eveningStart = 17 * 60 // 17:00 (1020 minutes)
  const eveningGraceEnd = eveningStart + sessionGracePeriod // 17:15 (1035 minutes)
  const firstHourEnd = eveningStart + 60 // 18:00 (1080 minutes)
  
  // Update statistics data
  statisticsData.calculationMethod = 'Overtime Evening Hourly'
  statisticsData.sessionGracePeriod = sessionGracePeriod
  statisticsData.totalMinutesWorked = totalMinutesWorked
  statisticsData.effectiveClockInMinutes = clockInMinutes
  statisticsData.effectiveClockOutMinutes = clockOutMinutes
  statisticsData.sessionStartMinutes = eveningStart
  statisticsData.sessionEndMinutes = clockOutMinutes
  
  console.log(`- Evening start: ${formatMinutes(eveningStart)} (17:00)`)
  console.log(`- Grace period end: ${formatMinutes(eveningGraceEnd)} (17:15)`)
  console.log(`- First hour end: ${formatMinutes(firstHourEnd)} (18:00)`)
  
  if (totalMinutesWorked <= 0) {
    statisticsData.specialNotes = `Evening session: No time worked (${totalMinutesWorked} minutes calculated)`
    console.log(`- Result: 0 hours (no time worked - ${totalMinutesWorked} minutes)`)
    return 0
  }
  
  let totalHours = 0
  
  // For evening sessions that start very late (22:00 or later), treat as continuous overtime
  const lateEveningStart = 22 * 60 // 22:00 (10:00 PM)
  
  if (clockInMinutes >= lateEveningStart) {
    console.log(`- LATE EVENING SHIFT: Clock in >= 22:00 - calculating as continuous overtime`)
    statisticsData.calculationMethod = 'Overtime Evening Continuous'
    
    // Apply grace period to total time worked
    const effectiveMinutesWorked = Math.max(0, totalMinutesWorked - sessionGracePeriod)
    
    console.log(`- Total minutes worked: ${totalMinutesWorked}`)
    console.log(`- Grace period applied: ${sessionGracePeriod} minutes`)
    console.log(`- Effective minutes worked: ${effectiveMinutesWorked}`)
    
    // Convert to hours with 30-minute rounding
    const exactHours = effectiveMinutesWorked / 60
    const wholeHours = Math.floor(exactHours)
    const remainingMinutes = effectiveMinutesWorked % 60
    
    totalHours = wholeHours
    
    if (remainingMinutes >= 30) {
      totalHours += 0.5
      console.log(`- Added 0.5 hours for ${remainingMinutes} remaining minutes`)
    } else if (remainingMinutes > 0) {
      console.log(`- ${remainingMinutes} remaining minutes < 30 - no addition`)
    }
    
    // Update detailed statistics
    statisticsData.eveningSessionHours = totalHours
    statisticsData.gracePeriodApplied = sessionGracePeriod > 0
    statisticsData.latenessMinutes = 0 // No lateness penalty for late evening shifts
    statisticsData.specialNotes = `Late evening continuous overtime: ${totalHours} hours from ${effectiveMinutesWorked} effective minutes`
    
    console.log(`- FINAL LATE EVENING RESULT: ${totalHours} hours`)
    return totalHours
  }
  
  // Original logic for regular evening sessions (17:00-22:00 clock ins)
  console.log(`- REGULAR EVENING SESSION: Using hourly calculation`)
  
  // Calculate first hour (17:00-18:00) with special grace period rule
  let firstHourCredit = 0
  let gracePeriodApplied = false
  let latenessMinutes = 0
  
  if (clockInMinutes <= eveningGraceEnd) {
    // On time - gets full first hour credit
    firstHourCredit = 1
    gracePeriodApplied = true
    console.log(`- Clock in <= 17:15 (grace period) → First hour credit: 1.0`)
  } else if (clockInMinutes < firstHourEnd) {
    // Late but within first hour - gets half credit  
    firstHourCredit = 0.5
    latenessMinutes = clockInMinutes - eveningGraceEnd
    console.log(`- Clock in 17:16-17:59 (late by ${latenessMinutes} min) → First hour credit: 0.5`)
  } else {
    // Clocked in after 18:00 - no first hour credit
    firstHourCredit = 0
    latenessMinutes = clockInMinutes - eveningGraceEnd
    console.log(`- Clock in >= 18:00 (late by ${latenessMinutes} min) → First hour credit: 0`)
  }
  
  totalHours += firstHourCredit
  
  // Calculate remaining hours after 18:00
  let additionalHours = 0
  if (clockOutMinutes > firstHourEnd) {
    const remainingStart = Math.max(clockInMinutes, firstHourEnd)
    const remainingMinutes = clockOutMinutes - remainingStart
    
    console.log(`- Remaining time after 18:00: ${remainingMinutes} minutes`)
    
    if (remainingMinutes > 0) {
      // Convert remaining minutes to hours with 30-minute rounding
      const exactRemainingHours = remainingMinutes / 60
      const wholeRemainingHours = Math.floor(exactRemainingHours)
      const remainingFraction = remainingMinutes % 60
      
      additionalHours = wholeRemainingHours
      
      if (remainingFraction >= 30) {
        additionalHours += 0.5
        console.log(`- Remaining: ${wholeRemainingHours} whole hours + 0.5 for ${remainingFraction} minutes`)
      } else if (remainingFraction > 0) {
        console.log(`- Remaining: ${wholeRemainingHours} whole hours (${remainingFraction} minutes < 30, no addition)`)
      }
      
      totalHours += additionalHours
      console.log(`- Additional hours after 18:00: ${additionalHours}`)
    }
  }
  
  // Update detailed statistics
  statisticsData.eveningSessionHours = totalHours
  statisticsData.gracePeriodApplied = gracePeriodApplied
  statisticsData.latenessMinutes = latenessMinutes
  statisticsData.specialNotes = `Evening session: base=${firstHourCredit}, additional=${additionalHours}, total=${totalHours}`
  
  console.log(`- FINAL CALCULATION: First hour (${firstHourCredit}) + Additional (${additionalHours}) = ${totalHours}`)
  console.log(`Evening session calculation with stats complete: ${totalHours} hours`)
  
  return totalHours
}

// Updated helper function to handle 24+ hour formatting
function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  
  // Handle next day display
  if (hours >= 24) {
    const displayHours = hours - 24
    return `${displayHours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')} (+1 day)`
  }
  
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`
}

function isLate(clockType, clockTime) {
  const hour = clockTime.getHours()
  const minute = clockTime.getMinutes()
  const totalMinutes = hour * 60 + minute

  const earlyMorningStart = 6 * 60 // 6:00 AM - new early morning boundary
  const morningStart = 8 * 60 // 8:00 AM
  const afternoonStart = 13 * 60 // 1:00 PM
  const gracePeriod = 5 // 5 minutes

  console.log(`Late check: ${clockType} at ${hour}:${minute.toString().padStart(2, '0')} (${totalMinutes} minutes)`)

  if (clockType === "morning_in") {
    // Special case for early morning shift (6:00-12:00)
    if (totalMinutes >= earlyMorningStart && totalMinutes <= earlyMorningStart + gracePeriod) {
      console.log(`Early morning threshold: ${earlyMorningStart + gracePeriod} minutes (6:05 AM), Result: ON TIME (early morning rule)`)
      return false
    }
    
    const isEmployeeLate = totalMinutes > morningStart + gracePeriod
    console.log(`Morning threshold: ${morningStart + gracePeriod} minutes (8:05 AM), Result: ${isEmployeeLate ? 'LATE' : 'ON TIME'}`)
    return isEmployeeLate
  } else if (clockType === "afternoon_in") {
    const isEmployeeLate = totalMinutes > afternoonStart + gracePeriod
    console.log(`Afternoon threshold: ${afternoonStart + gracePeriod} minutes (1:05 PM), Result: ${isEmployeeLate ? 'LATE' : 'ON TIME'}`)
    return isEmployeeLate
  }

  return false
}

function determineClockType(lastClockType, currentTime, lastClockTime = null) {
  const safeCurrentTime = currentTime || new Date(dateService.getCurrentDateTime())
  const hour = safeCurrentTime.getHours()
  const minute = safeCurrentTime.getMinutes()
  const totalMinutes = hour * 60 + minute
  const eveningStart = 17 * 60 + 15 // 5:15 PM (after overtime grace period)
  
  // Define afternoon end time (5:00 PM)
  const afternoonEnd = 17 * 60 // 5:00 PM
  
  // Night shift boundaries
  const nightShiftStart = 22 * 60 // 10:00 PM
  const earlyMorningEnd = 8 * 60 // 8:00 AM

  console.log(`=== CLOCK TYPE DETERMINATION ===`)
  console.log(`Input time: ${safeCurrentTime.toISOString()}`)
  console.log(`Parsed time: ${hour}:${minute.toString().padStart(2, '0')} (${totalMinutes} minutes from midnight)`)
  console.log(`Last clock type: ${lastClockType}`)
  console.log(`Evening start threshold: ${eveningStart} minutes (5:15 PM)`)
  console.log(`Afternoon end: ${afternoonEnd} minutes (5:00 PM)`)

  // Check if this might be an overnight shift continuation
  const isEarlyMorning = totalMinutes < earlyMorningEnd // Before 8:00 AM
  const isPossibleOvernightOut = isEarlyMorning && lastClockType && lastClockType.includes('_in')

  console.log(`Early morning check: ${isEarlyMorning}, Possible overnight out: ${isPossibleOvernightOut}`)

  // CRITICAL FIX: Check for overnight shifts with time validation
  if (lastClockTime && isPossibleOvernightOut) {
    const lastClockHour = lastClockTime.getHours()
    const lastClockMinutes = lastClockHour * 60 + lastClockTime.getMinutes()
    const currentClockMinutes = totalMinutes
    
    // If last clock was late in the evening/night (after 17:00) and current is early morning (before 8:00)
    // This indicates an overnight shift continuation
    if (lastClockMinutes >= afternoonEnd && currentClockMinutes < earlyMorningEnd) {
      console.log(`OVERNIGHT SHIFT DETECTED: Last clock at ${lastClockHour}:${lastClockTime.getMinutes().toString().padStart(2, '0')} (${lastClockMinutes} min), Current at ${hour}:${minute.toString().padStart(2, '0')} (${currentClockMinutes} min)`)
      
      // Return the corresponding out type for the overnight shift
      const overtimeOutType = lastClockType.replace('_in', '_out')
      console.log(`Overnight shift continuation: ${lastClockType} → ${overtimeOutType}`)
      return overtimeOutType
    }
  }

  if (!lastClockType) {
    // First clock of the day
    console.log(`No previous clock - determining by time:`)
    
    // Add overtime check for late night hours (22:00+)
    if (totalMinutes >= nightShiftStart) {
      console.log(`Time >= 10:00 PM → overtime_in`)
      return "overtime_in"
    }
    
    if (totalMinutes >= eveningStart) {
      console.log(`Time >= 5:15 PM → evening_in`)
      return "evening_in"
    }
    
    const clockType = hour < 12 ? "morning_in" : "afternoon_in"
    console.log(`Hour ${hour} < 12? ${hour < 12} → ${clockType}`)
    return clockType
  }

  console.log(`Processing sequence based on last clock: ${lastClockType}`)

  switch (lastClockType) {
    case "morning_in":
      // Check if this is an overnight shift (morning_in followed by early morning time)
      if (isPossibleOvernightOut) {
        console.log(`morning_in + early morning time (${totalMinutes} < ${earlyMorningEnd}) → morning_out (overnight shift)`)
        return "morning_out"
      }
      console.log(`morning_in → morning_out`)
      return "morning_out"
      
    case "morning_out":
      console.log(`morning_out → afternoon_in (lunch break assumed)`)
      return "afternoon_in"
      
    case "afternoon_in":
      // Check if this is an overnight shift 
      if (isPossibleOvernightOut) {
        console.log(`afternoon_in + early morning time (${totalMinutes} < ${earlyMorningEnd}) → afternoon_out (overnight shift)`)
        return "afternoon_out"
      }
      console.log(`afternoon_in → afternoon_out`)
      return "afternoon_out"
      
    case "afternoon_out":
      // After afternoon_out, any clock in after 5:00 PM should be evening_in
      if (totalMinutes >= afternoonEnd) {
        console.log(`afternoon_out + time after 5:00 PM (${totalMinutes} >= ${afternoonEnd}) → evening_in`)
        return "evening_in"
      }
      // If it's before 5:00 PM after afternoon_out, it's likely the next day
      const nextClockType = hour < 12 ? "morning_in" : "afternoon_in"
      console.log(`afternoon_out + before 5:00 PM → ${nextClockType} (likely next day)`)
      return nextClockType
      
    case "evening_in":
      // Evening session can go overnight - check for early morning clock out
      if (isPossibleOvernightOut) {
        console.log(`evening_in + early morning time (${totalMinutes} < ${earlyMorningEnd}) → evening_out (overnight shift)`)
        return "evening_out"
      }
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
      // CRITICAL FIX: Overtime session can go overnight - check for early morning clock out
      if (isPossibleOvernightOut) {
        console.log(`overtime_in + early morning time (${totalMinutes} < ${earlyMorningEnd}) → overtime_out (overnight shift)`)
        return "overtime_out"
      }
      console.log(`overtime_in → overtime_out`)
      return "overtime_out"
      
    case "overtime_out":
      // After overtime out, determine next clock type based on time
      if (totalMinutes >= nightShiftStart) {
        console.log(`overtime_out + late night time (>= 22:00) → overtime_in`)
        return "overtime_in"
      }
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

// Helper function to check for pending clock-outs for an employee
function getPendingClockOut(employeeUid, db = null) {
  let database = db
  if (!database) {
    try {
      const { getDatabase } = require('./setup')
      database = getDatabase()
    } catch (error) {
      console.error('Cannot get database connection:', error)
      return null
    }
  }

  try {
    const pendingClockQuery = database.prepare(`
      SELECT 
        id, clock_type, clock_time, date,
        regular_hours, overtime_hours
      FROM attendance 
      WHERE employee_uid = ? 
        AND clock_type LIKE '%_in'
        AND id NOT IN (
          SELECT a1.id FROM attendance a1
          JOIN attendance a2 ON a1.employee_uid = a2.employee_uid
          WHERE a1.clock_type LIKE '%_in' 
            AND a2.clock_type = REPLACE(a1.clock_type, '_in', '_out')
            AND a2.clock_time > a1.clock_time
            AND a1.employee_uid = ?
        )
      ORDER BY clock_time DESC 
      LIMIT 1
    `)
    
    const pendingClock = pendingClockQuery.get(employeeUid, employeeUid)
    
    if (pendingClock) {
      console.log(`Found pending clock-in for employee ${employeeUid}: ${pendingClock.clock_type} at ${pendingClock.clock_time}`)
      return {
        id: pendingClock.id,
        clockType: pendingClock.clock_type,
        clockTime: new Date(pendingClock.clock_time),
        date: pendingClock.date,
        expectedClockOut: pendingClock.clock_type.replace('_in', '_out'),
        regularHours: pendingClock.regular_hours || 0,
        overtimeHours: pendingClock.overtime_hours || 0
      }
    }
    
    return null
    
  } catch (error) {
    console.error('Error checking for pending clock-out:', error)
    return null
  }
}

// Helper function to get today's completed sessions for an employee
function getTodaysCompletedSessions(employeeUid, date = null, db = null) {
  let database = db
  if (!database) {
    try {
      const { getDatabase } = require('./setup')
      database = getDatabase()
    } catch (error) {
      console.error('Cannot get database connection:', error)
      return []
    }
  }

  const targetDate = date || new Date().toISOString().split('T')[0]

  try {
    const sessionsQuery = database.prepare(`
      SELECT 
        clock_type, clock_time, regular_hours, overtime_hours
      FROM attendance 
      WHERE employee_uid = ? 
        AND date = ?
        AND clock_type LIKE '%_out'
      ORDER BY clock_time ASC
    `)
    
    const sessions = sessionsQuery.all(employeeUid, targetDate)
    
    console.log(`Found ${sessions.length} completed sessions for employee ${employeeUid} on ${targetDate}`)
    
    return sessions.map(session => ({
      clockType: session.clock_type,
      clockTime: new Date(session.clock_time),
      regularHours: session.regular_hours || 0,
      overtimeHours: session.overtime_hours || 0
    }))
    
  } catch (error) {
    console.error('Error getting completed sessions:', error)
    return []
  }
}

//statistic
/**
 * Save detailed calculation statistics to the database
 * Call this function after each clock-out calculation
 */
function saveAttendanceStatistics(employeeUid, attendanceId, clockOutId, calculationData, db = null) {
  let database = db
  if (!database) {
    try {
      const { getDatabase } = require('./setup')
      database = getDatabase()
    } catch (error) {
      console.error('Cannot get database connection for statistics:', error)
      return null
    }
  }

  try {
    console.log(`=== SAVING ATTENDANCE STATISTICS ===`)
    console.log(`Employee UID: ${employeeUid}`)
    console.log(`Attendance ID: ${attendanceId}`)
    console.log(`Clock Out ID: ${clockOutId}`)

    const insertStats = database.prepare(`
      INSERT INTO attendance_statistics (
        employee_uid, attendance_id, clock_out_id, session_type,
        clock_in_time, clock_out_time, total_minutes_worked,
        regular_hours, overtime_hours, total_hours,
        early_arrival_minutes, early_arrival_overtime_hours,
        morning_session_hours, afternoon_session_hours, evening_session_hours,
        regular_overtime_hours, night_shift_hours,
        early_morning_rule_applied, overnight_shift, grace_period_applied, lunch_break_excluded,
        session_start_minutes, session_end_minutes, 
        effective_clock_in_minutes, effective_clock_out_minutes,
        lateness_minutes, grace_period_minutes, session_grace_period,
        calculation_method, special_notes, date
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `)

    const result = insertStats.run(
      employeeUid,
      attendanceId,
      clockOutId,
      calculationData.sessionType || 'unknown',
      calculationData.clockInTime ? calculationData.clockInTime.toISOString() : null,
      calculationData.clockOutTime ? calculationData.clockOutTime.toISOString() : null,
      calculationData.totalMinutesWorked || 0,
      calculationData.regularHours || 0,
      calculationData.overtimeHours || 0,
      (calculationData.regularHours || 0) + (calculationData.overtimeHours || 0),
      calculationData.earlyArrivalMinutes || 0,
      calculationData.earlyArrivalOvertimeHours || 0,
      calculationData.morningSessionHours || 0,
      calculationData.afternoonSessionHours || 0,
      calculationData.eveningSessionHours || 0,
      calculationData.regularOvertimeHours || 0,
      calculationData.nightShiftHours || 0,
      calculationData.earlyMorningRuleApplied ? 1 : 0,
      calculationData.overnightShift ? 1 : 0,
      calculationData.gracePeriodApplied ? 1 : 0,
      calculationData.lunchBreakExcluded ? 1 : 0,
      calculationData.sessionStartMinutes || null,
      calculationData.sessionEndMinutes || null,
      calculationData.effectiveClockInMinutes || null,
      calculationData.effectiveClockOutMinutes || null,
      calculationData.latenessMinutes || 0,
      calculationData.gracePeriodMinutes || 0,
      calculationData.sessionGracePeriod || 0,
      calculationData.calculationMethod || 'unknown',
      calculationData.specialNotes || null,
      calculationData.date || new Date().toISOString().split('T')[0]
    )

    console.log(`✓ Statistics saved with ID: ${result.lastInsertRowid}`)
    console.log(`=== END SAVING STATISTICS ===`)
    
    return result.lastInsertRowid

  } catch (error) {
    console.error('Error saving attendance statistics:', error)
    return null
  }
}

/**
 * Enhanced calculateHours function that also saves statistics
 * This replaces your existing calculateHours function
 */
function calculateHoursWithStats(clockType, clockTime, clockInTime = null, employeeUid = null, attendanceId = null, clockOutId = null, db = null) {
  const overtimeSessionGracePeriod = 15 // 15 minutes grace for overtime sessions

  let regularHours = 0
  let overtimeHours = 0

  // Initialize statistics tracking object
  const statisticsData = {
    sessionType: determineSessionType(clockType),
    clockInTime: clockInTime,
    clockOutTime: clockTime,
    totalMinutesWorked: 0,
    regularHours: 0,
    overtimeHours: 0,
    earlyArrivalMinutes: 0,
    earlyArrivalOvertimeHours: 0,
    morningSessionHours: 0,
    afternoonSessionHours: 0,
    eveningSessionHours: 0,
    regularOvertimeHours: 0,
    nightShiftHours: 0,
    earlyMorningRuleApplied: false,
    overnightShift: false,
    gracePeriodApplied: false,
    lunchBreakExcluded: false,
    sessionStartMinutes: null,
    sessionEndMinutes: null,
    effectiveClockInMinutes: null,
    effectiveClockOutMinutes: null,
    latenessMinutes: 0,
    gracePeriodMinutes: 5, // Default grace period
    sessionGracePeriod: overtimeSessionGracePeriod,
    calculationMethod: 'unknown',
    specialNotes: null,
    date: new Date().toISOString().split('T')[0]
  }

  console.log(`=== CALCULATE HOURS WITH STATISTICS ===`)
  console.log(`Clock type: ${clockType}`)
  console.log(`Clock out time: ${clockTime}`)
  console.log(`Clock in time: ${clockInTime}`)

  switch (clockType) {
    case "morning_in":
    case "afternoon_in":
    case "evening_in":
    case "overtime_in":
      console.log(`Clock-in type: ${clockType} - no hours to calculate`)
      regularHours = 0
      overtimeHours = 0
      statisticsData.calculationMethod = 'clock_in_only'
      break

    case "morning_out":
      if (clockInTime) {
        console.log(`Processing morning_out with continuous hours calculation`)
        const result = calculateContinuousHoursWithStats(clockInTime, clockTime, 'morning', statisticsData)
        regularHours = result.regularHours
        overtimeHours = result.overtimeHours
        console.log(`Morning session result: Regular=${regularHours}, Overtime=${overtimeHours}`)
      } else {
        console.log(`WARNING: morning_out without clockInTime`)
        statisticsData.specialNotes = 'WARNING: morning_out without clockInTime'
      }
      break

    case "afternoon_out":
      if (clockInTime) {
        console.log(`Processing afternoon_out with continuous hours calculation`)
        const result = calculateContinuousHoursWithStats(clockInTime, clockTime, 'afternoon', statisticsData)
        regularHours = result.regularHours
        overtimeHours = result.overtimeHours
        console.log(`Afternoon session result: Regular=${regularHours}, Overtime=${overtimeHours}`)
      } else {
        console.log(`WARNING: afternoon_out without clockInTime`)
        statisticsData.specialNotes = 'WARNING: afternoon_out without clockInTime'
      }
      break

    case "evening_out":
      if (clockInTime) {
        console.log(`Processing evening_out with session hours calculation`)
        overtimeHours = calculateEveningSessionHoursWithStats(clockInTime, clockTime, overtimeSessionGracePeriod, statisticsData)
        console.log(`Evening session result: Overtime=${overtimeHours}`)
      } else {
        console.log(`WARNING: evening_out without clockInTime`)
        statisticsData.specialNotes = 'WARNING: evening_out without clockInTime'
      }
      break

    case "overtime_out":
      if (clockInTime) {
        console.log(`Processing overtime_out with session hours calculation`)
        overtimeHours = calculateOvertimeSessionHoursWithStats(clockInTime, clockTime, overtimeSessionGracePeriod, statisticsData)
        console.log(`Overtime session result: Overtime=${overtimeHours}`)
      } else {
        console.log(`WARNING: overtime_out without clockInTime`)
        statisticsData.specialNotes = 'WARNING: overtime_out without clockInTime'
      }
      break

    default:
      console.log(`Unknown clock type: ${clockType}`)
      statisticsData.specialNotes = `Unknown clock type: ${clockType}`
      break
  }

  // Update final statistics
  statisticsData.regularHours = regularHours
  statisticsData.overtimeHours = overtimeHours
  
  if (clockInTime && clockTime) {
    let clockInMinutes = clockInTime.getHours() * 60 + clockInTime.getMinutes()
    let clockOutMinutes = clockTime.getHours() * 60 + clockTime.getMinutes()
    
    if (clockOutMinutes < clockInMinutes) {
      clockOutMinutes += 24 * 60
      statisticsData.overnightShift = true
    }
    
    statisticsData.totalMinutesWorked = clockOutMinutes - clockInMinutes
    statisticsData.effectiveClockInMinutes = clockInMinutes
    statisticsData.effectiveClockOutMinutes = clockOutMinutes
  }

  const finalResult = {
    regularHours: Math.round(regularHours * 100) / 100,
    overtimeHours: Math.round(overtimeHours * 100) / 100,
  }

  console.log(`=== FINAL CALCULATION RESULT ===`)
  console.log(`Regular Hours: ${finalResult.regularHours}`)
  console.log(`Overtime Hours: ${finalResult.overtimeHours}`)
  console.log(`Total Hours: ${finalResult.regularHours + finalResult.overtimeHours}`)

  // Save statistics if we have the required IDs
  if (employeeUid && clockOutId && clockType.includes('_out')) {
    console.log(`Saving statistics for employee ${employeeUid}...`)
    saveAttendanceStatistics(employeeUid, attendanceId, clockOutId, statisticsData, db)
  }

  return finalResult
}

/**
 * Enhanced continuous hours calculation that tracks statistics
 */
function calculateContinuousHoursWithStats(clockInTime, clockOutTime, startingSession, statisticsData) {
  let clockInMinutes = clockInTime.getHours() * 60 + clockInTime.getMinutes()
  let clockOutMinutes = clockOutTime.getHours() * 60 + clockOutTime.getMinutes()
  
  // Handle overnight shifts - if clock out is earlier in the day than clock in, add 24 hours
  if (clockOutMinutes < clockInMinutes) {
    clockOutMinutes += 24 * 60 // Add 24 hours worth of minutes
    statisticsData.overnightShift = true
    console.log(`Detected overnight shift - adjusted clock out to: ${formatMinutes(clockOutMinutes)} (next day)`)
  }
  
  // Update statistics with basic time data
  statisticsData.effectiveClockInMinutes = clockInMinutes
  statisticsData.effectiveClockOutMinutes = clockOutMinutes
  statisticsData.totalMinutesWorked = clockOutMinutes - clockInMinutes
  statisticsData.calculationMethod = 'Regular Hours'
  
  // Working hours boundaries
  const earlyMorningStart = 6 * 60 // 6:00 AM - new early morning boundary
  const morningStart = 8 * 60 // 8:00 AM
  const morningEnd = 12 * 60 // 12:00 PM
  const lunchStart = 12 * 60 // 12:00 PM (lunch break start)
  const lunchEnd = 13 * 60 // 1:00 PM (lunch break end)
  const afternoonStart = 13 * 60 // 1:00 PM
  const afternoonEnd = 17 * 60 // 5:00 PM
  const overtimeEnd = 22 * 60 // 10:00 PM (end of regular overtime)
  const nightShiftEnd = (6 * 60) + (24 * 60) // 6:00 AM next day
  const regularGracePeriod = 5 // 5 minutes grace per hour for regular hours
  const earlyMorningGracePeriod = 5 // 5 minutes grace for early morning overtime
  
  let totalRegularHours = 0
  let totalOvertimeHours = 0

  console.log(`=== CONTINUOUS HOURS CALCULATION WITH STATS ===`)
  console.log(`Clock in: ${formatMinutes(clockInMinutes)} (${clockInMinutes} min)`)
  console.log(`Clock out: ${formatMinutes(clockOutMinutes)} (${clockOutMinutes} min)`)
  console.log(`Starting session: ${startingSession}`)

  // Update statistics with session boundaries
  statisticsData.sessionStartMinutes = startingSession === 'morning' ? morningStart : afternoonStart
  statisticsData.sessionEndMinutes = startingSession === 'morning' ? morningEnd : afternoonEnd
  statisticsData.gracePeriodMinutes = regularGracePeriod

  // Check for NEW EARLY MORNING RULE (6:00-12:00)
  const earlyMorningGraceStart = earlyMorningStart - earlyMorningGracePeriod // 5:55 AM
  
  if (startingSession === 'morning' && 
      clockInMinutes >= earlyMorningGraceStart && 
      clockInMinutes < morningStart && // Must be before 8:00 AM to qualify
      clockOutMinutes >= morningEnd - 30) { // Must work close to 12:00 (within 30 min)
    
    console.log(`=== EARLY MORNING RULE APPLIED (6:00-12:00) ===`)
    statisticsData.earlyMorningRuleApplied = true
    statisticsData.specialNotes = 'Early morning rule applied (6:00-12:00 shift)'
    
    if (clockInMinutes <= earlyMorningStart + earlyMorningGracePeriod) { // Allow up to 6:05
      // Fixed allocation: 4 regular hours + 2 overtime hours = 6 total hours
      totalRegularHours = 4
      totalOvertimeHours = 2
      
      // Update detailed statistics
      statisticsData.morningSessionHours = 4
      statisticsData.earlyArrivalOvertimeHours = 2
      statisticsData.gracePeriodApplied = true
      
      console.log(`Early morning rule result: Regular=${totalRegularHours}, Overtime=${totalOvertimeHours}`)
      
      return {
        regularHours: totalRegularHours,
        overtimeHours: totalOvertimeHours
      }
    } else {
      statisticsData.specialNotes = 'Late for early morning shift - using normal calculation'
    }
  }

  // Handle different starting sessions
  if (startingSession === 'morning') {
    // Check for early arrival overtime (before 8:00 AM)
    if (clockInMinutes < morningStart) {
      const earlyArrivalEnd = Math.min(clockOutMinutes, morningStart)
      if (earlyArrivalEnd > clockInMinutes) {
        const earlyOvertimeHours = calculateSimpleOvertimeHours(clockInMinutes, earlyArrivalEnd)
        totalOvertimeHours += earlyOvertimeHours
        statisticsData.earlyArrivalMinutes = earlyArrivalEnd - clockInMinutes
        statisticsData.earlyArrivalOvertimeHours = earlyOvertimeHours
        console.log(`Early arrival overtime (${formatMinutes(clockInMinutes)} - ${formatMinutes(earlyArrivalEnd)}): ${earlyOvertimeHours} hours`)
      }
    }

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
        statisticsData.morningSessionHours = morningHours
        console.log(`Morning hours (${formatMinutes(morningStartTime)} - ${formatMinutes(morningEndTime)}): ${morningHours}`)
      }
    }

    // Calculate afternoon hours (13:00-17:00)
    if (clockOutMinutes > afternoonStart) {
      const afternoonStartTime = afternoonStart
      const afternoonEndTime = Math.min(clockOutMinutes, afternoonEnd)
      
      if (afternoonEndTime > afternoonStartTime) {
        const afternoonHours = calculateRegularHours(
          new Date(0, 0, 0, Math.floor(afternoonStartTime / 60), afternoonStartTime % 60),
          new Date(0, 0, 0, Math.floor(afternoonEndTime / 60), afternoonEndTime % 60),
          afternoonStart,
          afternoonEnd,
          regularGracePeriod
        )
        totalRegularHours += afternoonHours
        statisticsData.afternoonSessionHours = afternoonHours
        console.log(`Afternoon hours (${formatMinutes(afternoonStartTime)} - ${formatMinutes(afternoonEndTime)}): ${afternoonHours}`)
      }
    }

    // Handle lunch break logging
    if (clockInMinutes < lunchStart && clockOutMinutes > lunchEnd) {
      statisticsData.lunchBreakExcluded = true
      console.log(`Lunch break excluded: ${formatMinutes(lunchStart)} - ${formatMinutes(lunchEnd)} (1 hour)`)
    }
  } 
  else if (startingSession === 'afternoon') {
    // Similar logic for afternoon sessions...
    let effectiveAfternoonClockIn = clockInMinutes
    if (clockInMinutes < afternoonStart && clockInMinutes >= lunchStart) {
      effectiveAfternoonClockIn = afternoonStart
      statisticsData.specialNotes = 'Clock in during lunch break - treating as 13:00'
    }
    
    // Calculate afternoon hours
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
        statisticsData.afternoonSessionHours = afternoonHours
        console.log(`Afternoon hours (${formatMinutes(afternoonStartTime)} - ${formatMinutes(afternoonEndTime)}): ${afternoonHours}`)
      }
    }
  }

  // Calculate regular overtime hours (17:00-22:00) for both sessions
  if (clockOutMinutes > afternoonEnd) {
    const regularOvertimeStart = afternoonEnd
    const regularOvertimeEnd = Math.min(clockOutMinutes, overtimeEnd)
    
    if (regularOvertimeEnd > regularOvertimeStart) {
      const regularOvertimeHours = calculateSimpleOvertimeHours(regularOvertimeStart, regularOvertimeEnd)
      totalOvertimeHours += regularOvertimeHours
      statisticsData.regularOvertimeHours = regularOvertimeHours
      console.log(`Regular overtime hours (${formatMinutes(regularOvertimeStart)} - ${formatMinutes(regularOvertimeEnd)}): ${regularOvertimeHours}`)
    }
  }

  // Calculate night shift overtime hours (22:00-06:00 next day)
  if (clockOutMinutes > overtimeEnd) {
    const nightShiftStart = overtimeEnd
    const nightShiftEndTime = Math.min(clockOutMinutes, nightShiftEnd)
    
    if (nightShiftEndTime > nightShiftStart) {
      const nightShiftHours = calculateSimpleOvertimeHours(nightShiftStart, nightShiftEndTime)
      totalOvertimeHours += nightShiftHours
      statisticsData.nightShiftHours = nightShiftHours
      console.log(`Night shift overtime hours (${formatMinutes(nightShiftStart)} - ${formatMinutes(nightShiftEndTime)}): ${nightShiftHours}`)
    }
  }

  console.log(`Total regular hours: ${totalRegularHours}`)
  console.log(`Total overtime hours: ${totalOvertimeHours}`)
  console.log(`=== END CONTINUOUS CALCULATION WITH STATS ===`)

  return {
    regularHours: totalRegularHours,
    overtimeHours: totalOvertimeHours
  }
}

/**
 * Enhanced overtime session calculation with statistics tracking
 */
function calculateOvertimeSessionHoursWithStats(clockInTime, clockOutTime, sessionGracePeriod, statisticsData) {
  let clockInMinutes = clockInTime.getHours() * 60 + clockInTime.getMinutes()
  let clockOutMinutes = clockOutTime.getHours() * 60 + clockOutTime.getMinutes()
  
  // Handle overnight shifts
  if (clockOutMinutes < clockInMinutes) {
    clockOutMinutes += 24 * 60
    statisticsData.overnightShift = true
  }
  
  const totalMinutesWorked = clockOutMinutes - clockInMinutes
  const effectiveMinutesWorked = Math.max(0, totalMinutesWorked - sessionGracePeriod)
  
  statisticsData.calculationMethod = 'overtime_session'
  statisticsData.sessionGracePeriod = sessionGracePeriod
  statisticsData.totalMinutesWorked = totalMinutesWorked
  statisticsData.gracePeriodApplied = sessionGracePeriod > 0
  
  const totalHours = effectiveMinutesWorked / 60
  statisticsData.regularOvertimeHours = totalHours
  statisticsData.specialNotes = `Overtime session with ${sessionGracePeriod}min grace period`
  
  console.log(`Overtime session calculation with stats complete: ${totalHours} hours`)
  
  return totalHours
}

/**
 * Helper function to determine session type from clock type
 */
function determineSessionType(clockType) {
  if (clockType.includes('morning')) return 'morning'
  if (clockType.includes('afternoon')) return 'afternoon'  
  if (clockType.includes('evening')) return 'evening'
  if (clockType.includes('overtime')) return 'overtime'
  return 'unknown'
}

/**
 * Get statistical summary for an employee on a specific date
 */
function getEmployeeStatistics(employeeUid, date = null, db = null) {
  let database = db
  if (!database) {
    try {
      const { getDatabase } = require('./setup')
      database = getDatabase()
    } catch (error) {
      console.error('Cannot get database connection:', error)
      return null
    }
  }

  const targetDate = date || new Date().toISOString().split('T')[0]

  try {
    const statsQuery = database.prepare(`
      SELECT 
        s.*,
        e.first_name,
        e.last_name,
        e.id_number
      FROM attendance_statistics s
      JOIN employees e ON s.employee_uid = e.uid
      WHERE s.employee_uid = ? AND s.date = ?
      ORDER BY s.clock_in_time ASC
    `)
    
    const stats = statsQuery.all(employeeUid, targetDate)
    
    if (stats.length === 0) {
      return null
    }

    // Calculate daily totals
    const dailyTotals = stats.reduce((acc, stat) => {
      acc.totalRegularHours += stat.regular_hours || 0
      acc.totalOvertimeHours += stat.overtime_hours || 0
      acc.totalMinutesWorked += stat.total_minutes_worked || 0
      acc.sessionsCount += 1
      
      if (stat.early_morning_rule_applied) acc.earlyMorningRuleCount += 1
      if (stat.overnight_shift) acc.overnightShiftCount += 1
      if (stat.grace_period_applied) acc.gracePeriodCount += 1
      
      return acc
    }, {
      totalRegularHours: 0,
      totalOvertimeHours: 0,
      totalMinutesWorked: 0,
      sessionsCount: 0,
      earlyMorningRuleCount: 0,
      overnightShiftCount: 0,
      gracePeriodCount: 0
    })

    return {
      employee: {
        uid: employeeUid,
        name: `${stats[0].first_name} ${stats[0].last_name}`,
        idNumber: stats[0].id_number
      },
      date: targetDate,
      sessions: stats,
      dailyTotals: {
        ...dailyTotals,
        totalHours: dailyTotals.totalRegularHours + dailyTotals.totalOvertimeHours
      }
    }
    
  } catch (error) {
    console.error('Error getting employee statistics:', error)
    return null
  }
}

module.exports = {
  calculateHours,
  determineClockType,
  isLate,
  calculateContinuousHours,
  formatMinutes,
  calculateSimpleOvertimeHours,
  getPendingClockOut,
  getTodaysCompletedSessions,
  //statistic
  calculateHoursWithStats,
  saveAttendanceStatistics,
  calculateContinuousHoursWithStats,
  calculateEveningSessionHoursWithStats,
  calculateOvertimeSessionHoursWithStats,
  getEmployeeStatistics,
  determineSessionType
}