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
        const result = calculateContinuousHours(clockInTime, clockTime, "morning")
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
        const result = calculateContinuousHours(clockInTime, clockTime, "afternoon")
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
        // Evening sessions are ALWAYS overtime - don't apply 8-hour rule
        overtimeHours = calculateEveningSessionHours(clockInTime, clockTime, overtimeSessionGracePeriod)
        console.log(`Evening session result: Overtime=${overtimeHours}`)
      } else {
        console.log(`WARNING: evening_out without clockInTime`)
      }
      break

    case "overtime_out":
      if (clockInTime) {
        console.log(`Processing overtime_out with session hours calculation`)
        // Overtime sessions are ALWAYS overtime - don't apply 8-hour rule
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

  // FIXED: Only apply 8-hour regular rule to morning/afternoon sessions
  // Evening and overtime sessions should always remain as overtime
  let adjustedHours = { regularHours, overtimeHours }
  
  if (clockType === "morning_out" || clockType === "afternoon_out") {
    console.log(`Applying 8-hour regular rule for ${clockType}`)
    adjustedHours = apply8HourRegularRule(regularHours, overtimeHours)
  } else {
    console.log(`Skipping 8-hour regular rule for ${clockType} - keeping as overtime`)
  }

  const finalResult = {
    regularHours: Math.round(adjustedHours.regularHours * 100) / 100,
    overtimeHours: Math.round(adjustedHours.overtimeHours * 100) / 100,
  }

  console.log(`=== FINAL CALCULATION RESULT ===`)
  console.log(`Regular Hours: ${finalResult.regularHours}`)
  console.log(`Overtime Hours: ${finalResult.overtimeHours}`)
  console.log(`Total Hours: ${finalResult.regularHours + finalResult.overtimeHours}`)

  return finalResult
}

// NEW FUNCTION: Apply 8-hour regular completion rule
function apply8HourRegularRule(regularHours, overtimeHours) {
  const REQUIRED_REGULAR_HOURS = 8

  console.log(`=== APPLYING 8-HOUR REGULAR COMPLETION RULE ===`)
  console.log(`Initial regular hours: ${regularHours}`)
  console.log(`Initial overtime hours: ${overtimeHours}`)
  console.log(`Required regular hours: ${REQUIRED_REGULAR_HOURS}`)

  if (regularHours >= REQUIRED_REGULAR_HOURS) {
    // Employee has completed required regular hours - no adjustment needed
    console.log(`✓ Employee completed ${REQUIRED_REGULAR_HOURS} regular hours requirement`)
    console.log(`Final result: Regular=${regularHours}, Overtime=${overtimeHours}`)
    console.log(`=== END 8-HOUR RULE (NO ADJUSTMENT) ===`)

    return {
      regularHours: regularHours,
      overtimeHours: overtimeHours,
    }
  }

  // Employee hasn't completed required regular hours
  const regularDeficit = REQUIRED_REGULAR_HOURS - regularHours
  console.log(`✗ Employee missing ${regularDeficit} regular hours`)

  if (overtimeHours <= 0) {
    // No overtime to convert - just return as is
    console.log(`No overtime hours to convert - keeping original values`)
    console.log(`Final result: Regular=${regularHours}, Overtime=${overtimeHours}`)
    console.log(`=== END 8-HOUR RULE (NO OVERTIME TO CONVERT) ===`)

    return {
      regularHours: regularHours,
      overtimeHours: overtimeHours,
    }
  }

  // Calculate how much overtime to convert to regular
  const overtimeToConvert = Math.min(regularDeficit, overtimeHours)
  const newRegularHours = regularHours + overtimeToConvert
  const newOvertimeHours = overtimeHours - overtimeToConvert

  console.log(`Converting ${overtimeToConvert} overtime hours to regular hours`)
  console.log(`Regular hours: ${regularHours} + ${overtimeToConvert} = ${newRegularHours}`)
  console.log(`Overtime hours: ${overtimeHours} - ${overtimeToConvert} = ${newOvertimeHours}`)

  if (newRegularHours >= REQUIRED_REGULAR_HOURS) {
    console.log(`✓ Employee now meets ${REQUIRED_REGULAR_HOURS}-hour regular requirement`)
  } else {
    console.log(`⚠ Employee still ${REQUIRED_REGULAR_HOURS - newRegularHours} hours short of regular requirement`)
  }

  console.log(`Final result: Regular=${newRegularHours}, Overtime=${newOvertimeHours}`)
  console.log(`=== END 8-HOUR RULE (CONVERTED ${overtimeToConvert} HOURS) ===`)

  return {
    regularHours: newRegularHours,
    overtimeHours: newOvertimeHours,
  }
}

function calculateContinuousHours(clockInTime, clockOutTime, startingSession) {
  // FIXED: Ensure parameters are Date objects
  const safeClockInTime = clockInTime instanceof Date ? clockInTime : new Date(clockInTime)
  const safeClockOutTime = clockOutTime instanceof Date ? clockOutTime : new Date(clockOutTime)
  
  const clockInMinutes = safeClockInTime.getHours() * 60 + safeClockInTime.getMinutes()
  let clockOutMinutes = safeClockOutTime.getHours() * 60 + safeClockOutTime.getMinutes()

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
  const nightShiftEnd = 6 * 60 + 24 * 60 // 6:00 AM next day
  const regularGracePeriod = 5 // 5 minutes grace per hour for regular hours
  const earlyMorningGracePeriod = 5 // Keep original 5 minutes for early morning

  let totalRegularHours = 0
  let totalOvertimeHours = 0

  console.log(`=== CONTINUOUS HOURS CALCULATION ===`)
  console.log(`Clock in: ${formatMinutes(clockInMinutes)} (${clockInMinutes} min)`)
  console.log(`Clock out: ${formatMinutes(clockOutMinutes)} (${clockOutMinutes} min)`)
  console.log(`Starting session: ${startingSession}`)

  // NEW ENHANCED EARLY MORNING RULE (6:00-8:00 only for overtime portion)
  // Rule applies if: morning session + clock in between 6:00-8:00
  const earlyMorningGraceStart = earlyMorningStart - earlyMorningGracePeriod // 5:55 AM
  let earlyMorningOvertimeHours = 0

  if (startingSession === "morning" && clockInMinutes >= earlyMorningGraceStart && clockInMinutes < morningStart) {
    // Must be before 8:00 AM to qualify for early morning overtime

    console.log(`=== EARLY MORNING OVERTIME CALCULATION (6:00-8:00) ===`)
    console.log(`Clock in: ${formatMinutes(clockInMinutes)} (qualifies for early morning overtime)`)

    // Calculate overtime hours for the 6:00-8:00 AM period only
    if (clockInMinutes <= earlyMorningStart + earlyMorningGracePeriod) {
      // Up to 6:05 AM
      console.log(`=== EARLY MORNING OVERTIME: On-time for 6:00 AM ===`)
      console.log(`Clock in within 6:00 AM grace period: ${formatMinutes(clockInMinutes)} <= 6:05 AM`)
      console.log(`Awarding 2 overtime hours for 6:00-8:00 AM period`)

      // Award 2 overtime hours for the 6:00-8:00 AM period
      earlyMorningOvertimeHours = 2
    } else {
      // Apply 30-minute rule for late early morning shifts (same as before)
      console.log(`=== EARLY MORNING OVERTIME: Late arrival ===`)
      console.log(`Clock in after 6:05 AM: ${formatMinutes(clockInMinutes)}`)

      // Check each hour in the 6:00-8:00 AM period with 30-minute rule
      let calculatedOvertimeHours = 0

      // Hour 1: 6:00-7:00 AM
      const hour1Start = 6 * 60 // 6:00 AM
      const hour1End = 7 * 60 // 7:00 AM
      const lateForHour1 = Math.max(0, clockInMinutes - hour1Start)

      console.log(`Hour 1 (6:00-7:00): Late by ${lateForHour1} minutes`)

      if (clockInMinutes < hour1End) {
        // Clocked in before 7:00 AM
        if (lateForHour1 <= 30) {
          // Within 30-minute rule
          if (lateForHour1 <= regularGracePeriod) {
            calculatedOvertimeHours += 1 // On time, full hour
            console.log(`Hour 1: 1.0 overtime hour (on time)`)
          } else {
            calculatedOvertimeHours += 0.5 // Late but within 30 min, half hour
            console.log(`Hour 1: 0.5 overtime hour (late 6-30 min)`)
          }
        } else {
          console.log(`Hour 1: 0 overtime hours (>30 min late - VOID)`)
        }
      } else {
        console.log(`Hour 1: 0 overtime hours (missed entirely)`)
      }

      // Hour 2: 7:00-8:00 AM
      const hour2Start = 7 * 60 // 7:00 AM
      const hour2End = 8 * 60 // 8:00 AM
      const lateForHour2 = Math.max(0, clockInMinutes - hour2Start)

      console.log(`Hour 2 (7:00-8:00): Late by ${lateForHour2} minutes`)

      if (clockInMinutes < hour2End) {
        // Clocked in before 8:00 AM
        if (lateForHour2 <= regularGracePeriod) {
          calculatedOvertimeHours += 1 // On time (within 5 min grace), full hour
          console.log(`Hour 2: 1.0 overtime hour (on time - within ${regularGracePeriod} min grace)`)
        } else if (lateForHour2 < 30) {
          // Less than 30 minutes
          calculatedOvertimeHours += 0.5 // Late 6-29 min, half hour
          console.log(`Hour 2: 0.5 overtime hour (late ${lateForHour2} min - between 6-29 min)`)
        } else {
          console.log(`Hour 2: 0 overtime hours (${lateForHour2} min late - >=30 min VOID)`)
        }
      } else {
        console.log(`Hour 2: 0 overtime hours (missed entirely)`)
      }

      earlyMorningOvertimeHours = calculatedOvertimeHours
      console.log(`Late early morning overtime calculation: ${calculatedOvertimeHours} overtime hours`)
    }

    totalOvertimeHours += earlyMorningOvertimeHours
    console.log(`Early morning overtime hours added: ${earlyMorningOvertimeHours}`)
    console.log(`=== END EARLY MORNING OVERTIME CALCULATION ===`)
  }

  // Continue with regular hours calculation for the full day
  if (startingSession === "morning") {
    // Calculate morning hours (8:00-12:00) - regardless of early morning rule
    if (clockInMinutes < morningEnd && clockOutMinutes > morningStart) {
      const morningStartTime = Math.max(clockInMinutes, morningStart)
      const morningEndTime = Math.min(clockOutMinutes, morningEnd)

      if (morningEndTime > morningStartTime) {
        const morningHours = calculateRegularHours(
          new Date(0, 0, 0, Math.floor(morningStartTime / 60), morningStartTime % 60),
          new Date(0, 0, 0, Math.floor(morningEndTime / 60), morningEndTime % 60),
          morningStart,
          morningEnd,
          regularGracePeriod,
        )
        totalRegularHours += morningHours
        console.log(
          `Morning hours (${formatMinutes(morningStartTime)} - ${formatMinutes(morningEndTime)}): ${morningHours}`,
        )
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
          regularGracePeriod,
        )
        totalRegularHours += afternoonHours
        console.log(
          `Afternoon hours (${formatMinutes(afternoonStartTime)} - ${formatMinutes(afternoonEndTime)}): ${afternoonHours}`,
        )
      }
    }

    // Calculate regular overtime hours (17:00-22:00)
    if (clockOutMinutes > afternoonEnd) {
      const regularOvertimeStart = afternoonEnd
      const regularOvertimeEnd = Math.min(clockOutMinutes, overtimeEnd)

      if (regularOvertimeEnd > regularOvertimeStart) {
        const regularOvertimeHours = calculateSimpleOvertimeHours(regularOvertimeStart, regularOvertimeEnd)
        totalOvertimeHours += regularOvertimeHours
        console.log(
          `Regular overtime hours (${formatMinutes(regularOvertimeStart)} - ${formatMinutes(regularOvertimeEnd)}): ${regularOvertimeHours}`,
        )
      }
    }

    // Calculate night shift overtime hours (22:00-06:00 next day)
    if (clockOutMinutes > overtimeEnd) {
      const nightShiftStart = overtimeEnd
      const nightShiftEndTime = Math.min(clockOutMinutes, nightShiftEnd)

      if (nightShiftEndTime > nightShiftStart) {
        const nightShiftHours = calculateSimpleOvertimeHours(nightShiftStart, nightShiftEndTime)
        totalOvertimeHours += nightShiftHours
        console.log(
          `Night shift overtime hours (${formatMinutes(nightShiftStart)} - ${formatMinutes(nightShiftEndTime)}): ${nightShiftHours}`,
        )
      }
    }

    // Handle lunch break logging
    if (clockInMinutes < lunchStart && clockOutMinutes > lunchEnd) {
      console.log(`Lunch break excluded: ${formatMinutes(lunchStart)} - ${formatMinutes(lunchEnd)} (1 hour)`)
    } else if (clockInMinutes < lunchStart && clockOutMinutes > lunchStart && clockOutMinutes <= lunchEnd) {
      console.log(`Clocked out during lunch break - no afternoon hours counted`)
    }
  } else if (startingSession === "afternoon") {
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
        console.log(
          `Early afternoon arrival overtime (${formatMinutes(clockInMinutes)} - ${formatMinutes(earlyAfternoonEnd)}): ${earlyAfternoonOvertime} hours`,
        )
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
          regularGracePeriod,
        )
        totalRegularHours += afternoonHours
        console.log(
          `Afternoon hours (${formatMinutes(afternoonStartTime)} - ${formatMinutes(afternoonEndTime)}): ${afternoonHours}`,
        )
      }
    }

    // Calculate regular overtime hours (17:00-22:00)
    if (clockOutMinutes > afternoonEnd) {
      const regularOvertimeStart = afternoonEnd
      const regularOvertimeEnd = Math.min(clockOutMinutes, overtimeEnd)

      if (regularOvertimeEnd > regularOvertimeStart) {
        const regularOvertimeHours = calculateSimpleOvertimeHours(regularOvertimeStart, regularOvertimeEnd)
        totalOvertimeHours += regularOvertimeHours
        console.log(
          `Regular overtime hours (${formatMinutes(regularOvertimeStart)} - ${formatMinutes(regularOvertimeEnd)}): ${regularOvertimeHours}`,
        )
      }
    }

    // Calculate night shift overtime hours (22:00-06:00 next day)
    if (clockOutMinutes > overtimeEnd) {
      const nightShiftStart = overtimeEnd
      const nightShiftEndTime = Math.min(clockOutMinutes, nightShiftEnd)

      if (nightShiftEndTime > nightShiftStart) {
        const nightShiftHours = calculateSimpleOvertimeHours(nightShiftStart, nightShiftEndTime)
        totalOvertimeHours += nightShiftHours
        console.log(
          `Night shift overtime hours (${formatMinutes(nightShiftStart)} - ${formatMinutes(nightShiftEndTime)}): ${nightShiftHours}`,
        )
      }
    }
  }

  console.log(`=== CALCULATION SUMMARY ===`)
  console.log(`Early morning overtime (6:00-8:00): ${earlyMorningOvertimeHours} hours`)
  console.log(`Regular hours (8:00-12:00 + 13:00-17:00): ${totalRegularHours} hours`)
  console.log(`Other overtime hours: ${totalOvertimeHours - earlyMorningOvertimeHours} hours`)
  console.log(`Total regular hours: ${totalRegularHours}`)
  console.log(`Total overtime hours: ${totalOvertimeHours}`)
  console.log(`Grand total: ${totalRegularHours + totalOvertimeHours} hours`)
  console.log(`=== END CONTINUOUS CALCULATION ===`)

  return {
    regularHours: totalRegularHours,
    overtimeHours: totalOvertimeHours,
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

function calculateContinuousOvertimeHours(startMinutes, endMinutes) {
    const totalMinutes = endMinutes - startMinutes

  console.log(`=== EVENING OVERTIME CALCULATION WITH NEW RULE ===`)
  console.log(`Start: ${formatMinutes(startMinutes)} (${startMinutes} min)`)
  console.log(`End: ${formatMinutes(endMinutes)} (${endMinutes} min)`)
  console.log(`Total minutes: ${totalMinutes}`)

  if (totalMinutes <= 0) {
    console.log(`No overtime minutes - returning 0`)
    return 0
  }

  // Convert minutes to hours with NEW 25-55 minute rounding rule for evening sessions
  const exactHours = totalMinutes / 60
  const wholeHours = Math.floor(exactHours)
  const remainingMinutes = totalMinutes % 60

  console.log(`Exact hours: ${exactHours}`)
  console.log(`Whole hours: ${wholeHours}`)
  console.log(`Remaining minutes: ${remainingMinutes}`)

  let finalHours = wholeHours

  // NEW EVENING ROUNDING RULE:
  // 25-55 minutes = 0.5 hours
  // 55+ minutes = 1 hour
  // 0-24 minutes = no addition
  if (remainingMinutes >= 55) {
    finalHours += 1
    console.log(`Added 1.0 hour for ${remainingMinutes} remaining minutes (>=55 min rule)`)
  } else if (remainingMinutes >= 25) {
    finalHours += 0.5
    console.log(`Added 0.5 hours for ${remainingMinutes} remaining minutes (25-54 min rule)`)
  } else if (remainingMinutes > 0) {
    console.log(`${remainingMinutes} remaining minutes < 25 - no addition`)
  }

  console.log(`Final evening overtime hours: ${finalHours}`)
  console.log(`=== END EVENING OVERTIME CALCULATION ===`)

  return finalHours
}

function calculateRegularHours(clockInTime, clockOutTime, sessionStart, sessionEnd, gracePeriod) {
  const safeClockInTime = clockInTime instanceof Date ? clockInTime : new Date(clockInTime)
  const safeClockOutTime = clockOutTime instanceof Date ? clockOutTime : new Date(clockOutTime)

  const clockInMinutes = safeClockInTime.getHours() * 60 + safeClockInTime.getMinutes()
  const clockOutMinutes = safeClockOutTime.getHours() * 60 + safeClockOutTime.getMinutes()

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
    const hourStartTime = sessionStart + hourIndex * 60
    const hourEndTime = sessionStart + (hourIndex + 1) * 60

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
  // FIXED: Ensure parameters are Date objects
  const safeClockInTime = clockInTime instanceof Date ? clockInTime : new Date(clockInTime)
  const safeClockOutTime = clockOutTime instanceof Date ? clockOutTime : new Date(clockOutTime)
  
  const clockInMinutes = safeClockInTime.getHours() * 60 + safeClockInTime.getMinutes()
  let clockOutMinutes = safeClockOutTime.getHours() * 60 + safeClockOutTime.getMinutes()

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

function calculateEveningSessionHours(clockInTime, clockOutTime, sessionGracePeriod) {
  const safeClockInTime = clockInTime instanceof Date ? clockInTime : new Date(clockInTime)
  const safeClockOutTime = clockOutTime instanceof Date ? clockOutTime : new Date(clockOutTime)

  const clockInMinutes = safeClockInTime.getHours() * 60 + safeClockInTime.getMinutes()
  let clockOutMinutes = safeClockOutTime.getHours() * 60 + safeClockOutTime.getMinutes()

  console.log(`Evening session calculation with NEW ROUNDING RULE - INITIAL:`)
  console.log(`- Clock in: ${formatMinutes(clockInMinutes)} (${clockInMinutes} minutes)`)
  console.log(`- Clock out: ${formatMinutes(clockOutMinutes)} (${clockOutMinutes} minutes)`)

  // Check for overnight shift
  let isOvernightShift = false
  if (clockOutMinutes < clockInMinutes) {
    clockOutMinutes += 24 * 60 // Add 24 hours worth of minutes
    isOvernightShift = true
    console.log(
      `- OVERNIGHT DETECTED: Adjusted clock out to: ${formatMinutes(clockOutMinutes)} (${clockOutMinutes} minutes)`,
    )
  }

  const totalMinutesWorked = clockOutMinutes - clockInMinutes
  console.log(`- CALCULATED: Total minutes worked = ${clockOutMinutes} - ${clockInMinutes} = ${totalMinutesWorked}`)

  if (totalMinutesWorked <= 0) {
    console.log(`- Result: 0 hours (no time worked - ${totalMinutesWorked} minutes)`)
    return 0
  }

  let totalHours = 0

  // Apply appropriate calculation method
  if (isOvernightShift) {
    console.log(`=== APPLYING CONTINUOUS HOURS WITH NEW EVENING RULE ===`)
    totalHours = calculateEveningContinuousHours(
      clockInTime,
      clockOutTime,
      clockInMinutes,
      clockOutMinutes,
      sessionGracePeriod,
    )
  } else {
    // Original session calculation for same-day evening work with NEW RULE
    console.log(`=== APPLYING ORIGINAL SESSION CALCULATION WITH NEW RULE ===`)
    const eveningStart = 17 * 60 // 17:00
    const eveningGraceEnd = eveningStart + sessionGracePeriod // 17:15

    totalHours = calculateOriginalEveningSession(
      clockInMinutes,
      clockOutMinutes,
      eveningStart,
      eveningGraceEnd,
      sessionGracePeriod,
    )
  }

  console.log(`Evening session calculation with NEW RULE complete: ${totalHours} hours`)
  return totalHours
}

function calculateOriginalEveningSession(
  clockInMinutes,
  clockOutMinutes,
  eveningStart,
  eveningGraceEnd,
  sessionGracePeriod,
) {
  const firstHourEnd = eveningStart + 60 // 18:00
  let totalHours = 0

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

  // Calculate remaining hours after 18:00 using EVENING ROUNDING RULE
  if (clockOutMinutes > firstHourEnd) {
    const remainingStart = Math.max(clockInMinutes, firstHourEnd)
    const remainingMinutes = clockOutMinutes - remainingStart

    console.log(`- Remaining time after 18:00: ${remainingMinutes} minutes`)

    if (remainingMinutes > 0) {
      // EVENING SESSION SPECIFIC RULE:
      // 25-55 minutes = 0.5 hours
      // 56+ minutes = 1 hour
      // 0-24 minutes = no addition
      const wholeHours = Math.floor(remainingMinutes / 60)
      const remainingFraction = remainingMinutes % 60

      let additionalHours = wholeHours

      if (remainingFraction >= 56) {
        additionalHours += 1
        console.log(`- Added 1.0 hour for ${remainingFraction} remaining minutes (>=56 min evening rule)`)
      } else if (remainingFraction >= 25) {
        additionalHours += 0.5
        console.log(`- Added 0.5 hours for ${remainingFraction} remaining minutes (25-55 min evening rule)`)
      } else if (remainingFraction > 0) {
        console.log(`- ${remainingFraction} remaining minutes < 25 - no addition (evening rule)`)
      }

      totalHours += additionalHours
      console.log(`- Additional hours after 18:00 (with evening rule): ${additionalHours}`)
    }
  }

  console.log(`- EVENING SESSION WITH EVENING ROUNDING RULE: First hour (${firstHourCredit}) + Additional = ${totalHours}`)
  return totalHours
}

function calculateEveningContinuousHours(
  clockInTime,
  clockOutTime,
  clockInMinutes,
  clockOutMinutes,
  sessionGracePeriod,
) {
  console.log(`=== EVENING CONTINUOUS HOURS WITH NEW ROUNDING RULE ===`)
  console.log(`This evening session extends to the next day - calculating as continuous work`)

  // Time boundaries for continuous calculation
  const eveningStart = 17 * 60 // 17:00
  const regularOvertimeEnd = 22 * 60 // 22:00 (end of regular overtime)
  const nightShiftEnd = 6 * 60 + 24 * 60 // 6:00 AM next day

  let totalOvertimeHours = 0
  const calculationBreakdown = []

  // SEGMENT 1: Evening overtime (17:00-22:00) with NEW ROUNDING RULE
  const eveningOvertimeStart = Math.max(clockInMinutes, eveningStart)
  const eveningOvertimeEnd = Math.min(clockOutMinutes, regularOvertimeEnd)

  if (eveningOvertimeEnd > eveningOvertimeStart) {
    // Apply grace period to evening segment if user clocked in on time
    let effectiveEveningStart = eveningOvertimeStart
    let gracePeriodApplied = false

    if (clockInMinutes <= eveningStart + sessionGracePeriod) {
      // User was on time or within grace period - apply grace period benefit
      const gracePeriodBenefit = Math.min(sessionGracePeriod, eveningOvertimeEnd - eveningOvertimeStart)
      effectiveEveningStart = Math.max(eveningStart, clockInMinutes - gracePeriodBenefit)
      gracePeriodApplied = true
      console.log(`- Grace period applied: ${gracePeriodBenefit} minutes benefit`)
    }

    // Use NEW evening overtime calculation with 25-55 minute rule
    const eveningOvertimeHours = calculateEveningSessionHours(effectiveEveningStart, eveningOvertimeEnd)

    totalOvertimeHours += eveningOvertimeHours
    calculationBreakdown.push(
      `Evening overtime (${formatMinutes(effectiveEveningStart)}-${formatMinutes(eveningOvertimeEnd)}): ${eveningOvertimeHours} hours${gracePeriodApplied ? " (with grace period)" : ""}`,
    )

    console.log(`- Evening overtime segment with NEW RULE: ${eveningOvertimeHours} hours`)
  }

  // SEGMENT 2: Night shift overtime (22:00-06:00 next day) - keep original 30-minute rule
  if (clockOutMinutes > regularOvertimeEnd) {
    const nightShiftStart = Math.max(clockInMinutes, regularOvertimeEnd)
    const nightShiftEndTime = Math.min(clockOutMinutes, nightShiftEnd)

    if (nightShiftEndTime > nightShiftStart) {
      // Use original 30-minute rule for night shift
      const nightShiftHours = calculateContinuousOvertimeHours(nightShiftStart, nightShiftEndTime)

      totalOvertimeHours += nightShiftHours
      calculationBreakdown.push(
        `Night shift overtime (${formatMinutes(nightShiftStart)}-${formatMinutes(nightShiftEndTime)}): ${nightShiftHours} hours`,
      )

      console.log(`- Night shift segment (original 30-min rule): ${nightShiftHours} hours`)
    }
  }

  // SEGMENT 3: Extended night work (06:00+ next day) - keep original 30-minute rule
  if (clockOutMinutes > nightShiftEnd) {
    const extendedNightStart = nightShiftEnd
    const extendedNightEnd = clockOutMinutes

    // Use original 30-minute rule for extended night work
    const extendedNightHours = calculateContinuousOvertimeHours(extendedNightStart, extendedNightEnd)

    totalOvertimeHours += extendedNightHours
    calculationBreakdown.push(
      `Extended night work (${formatMinutes(extendedNightStart)}-${formatMinutes(extendedNightEnd)}): ${extendedNightHours} hours`,
    )

    console.log(`- Extended night segment (original 30-min rule): ${extendedNightHours} hours`)
    console.log(`- WARNING: Work extended beyond 6:00 AM - please verify this is correct`)
  }

  console.log(`=== EVENING CONTINUOUS CALCULATION SUMMARY WITH NEW RULE ===`)
  calculationBreakdown.forEach((line) => console.log(`- ${line}`))
  console.log(`- Total continuous overtime hours: ${totalOvertimeHours}`)
  console.log(`=== END EVENING CONTINUOUS CALCULATION ===`)

  return totalOvertimeHours
}

function calculateEveningSessionHoursWithStats(clockInTime, clockOutTime, sessionGracePeriod, statisticsData) {
  // FIXED: Ensure parameters are Date objects
  const safeClockInTime = clockInTime instanceof Date ? clockInTime : new Date(clockInTime)
  const safeClockOutTime = clockOutTime instanceof Date ? clockOutTime : new Date(clockOutTime)
  
  const clockInMinutes = safeClockInTime.getHours() * 60 + safeClockInTime.getMinutes()
  let clockOutMinutes = safeClockOutTime.getHours() * 60 + safeClockOutTime.getMinutes()

  console.log(`Evening session calculation with stats - INITIAL:`)
  console.log(`- Clock in: ${formatMinutes(clockInMinutes)} (${clockInMinutes} minutes)`)
  console.log(`- Clock out: ${formatMinutes(clockOutMinutes)} (${clockOutMinutes} minutes)`)

  // Check for overnight shift
  let isOvernightShift = false
  if (clockOutMinutes < clockInMinutes) {
    clockOutMinutes += 24 * 60 // Add 24 hours worth of minutes
    isOvernightShift = true
    statisticsData.overnightShift = true
    console.log(
      `- OVERNIGHT DETECTED: Adjusted clock out to: ${formatMinutes(clockOutMinutes)} (${clockOutMinutes} minutes)`,
    )
  }

  const totalMinutesWorked = clockOutMinutes - clockInMinutes
  console.log(`- CALCULATED: Total minutes worked = ${clockOutMinutes} - ${clockInMinutes} = ${totalMinutesWorked}`)

  // Update basic statistics
  statisticsData.sessionGracePeriod = sessionGracePeriod
  statisticsData.totalMinutesWorked = totalMinutesWorked
  statisticsData.effectiveClockInMinutes = clockInMinutes
  statisticsData.effectiveClockOutMinutes = clockOutMinutes

  if (totalMinutesWorked <= 0) {
    statisticsData.calculationMethod = "Evening Session - No Time"
    statisticsData.specialNotes = `Evening session: No time worked (${totalMinutesWorked} minutes calculated)`
    console.log(`- Result: 0 hours (no time worked - ${totalMinutesWorked} minutes)`)
    return 0
  }

  let totalHours = 0

  // Apply continuous hours calculation for overnight shifts
  if (isOvernightShift) {
    console.log(`=== APPLYING CONTINUOUS HOURS WITH STATS ===`)
    statisticsData.calculationMethod = "Evening Continuous Overtime"
    statisticsData.specialNotes = "Evening session extended to next day - calculated as continuous work"

    totalHours = calculateEveningContinuousHoursWithStats(
      safeClockInTime,  // Pass the safe Date objects
      safeClockOutTime,
      clockInMinutes,
      clockOutMinutes,
      sessionGracePeriod,
      statisticsData,
    )
  } else {
    // Original session calculation for same-day evening work
    console.log(`=== APPLYING ORIGINAL SESSION CALCULATION WITH STATS ===`)
    statisticsData.calculationMethod = "Evening Session Hourly"

    totalHours = calculateOriginalEveningSessionWithStats(
      clockInMinutes,
      clockOutMinutes,
      sessionGracePeriod,
      statisticsData,
    )
  }

  statisticsData.eveningSessionHours = totalHours
  console.log(`Evening session calculation with stats complete: ${totalHours} hours`)

  return totalHours
}

function calculateEveningContinuousHoursWithStats(
  clockInTime,
  clockOutTime,
  clockInMinutes,
  clockOutMinutes,
  sessionGracePeriod,
  statisticsData,
) {
  console.log(`=== EVENING CONTINUOUS HOURS WITH STATS ===`)

  const eveningStart = 17 * 60 // 17:00
  const regularOvertimeEnd = 22 * 60 // 22:00
  const nightShiftEnd = 6 * 60 + 24 * 60 // 6:00 AM next day

  let totalOvertimeHours = 0
  const segmentBreakdown = {
    eveningSegment: 0,
    nightShiftSegment: 0,
    extendedNightSegment: 0,
  }

  // Evening overtime segment (17:00-22:00)
  const eveningOvertimeStart = Math.max(clockInMinutes, eveningStart)
  const eveningOvertimeEnd = Math.min(clockOutMinutes, regularOvertimeEnd)

  if (eveningOvertimeEnd > eveningOvertimeStart) {
    let effectiveEveningStart = eveningOvertimeStart
    let gracePeriodApplied = false

    // Apply grace period for on-time arrival
    if (clockInMinutes <= eveningStart + sessionGracePeriod) {
      const gracePeriodBenefit = Math.min(sessionGracePeriod, eveningOvertimeEnd - eveningOvertimeStart)
      effectiveEveningStart = Math.max(eveningStart, clockInMinutes - gracePeriodBenefit)
      gracePeriodApplied = true
      statisticsData.gracePeriodApplied = true
      console.log(`- Grace period applied: ${gracePeriodBenefit} minutes benefit`)
    }

    const eveningSegmentHours = calculateContinuousOvertimeHours(effectiveEveningStart, eveningOvertimeEnd)
    totalOvertimeHours += eveningSegmentHours
    segmentBreakdown.eveningSegment = eveningSegmentHours

    console.log(`- Evening segment: ${eveningSegmentHours} hours`)
  }

  // Night shift segment (22:00-06:00)
  if (clockOutMinutes > regularOvertimeEnd) {
    const nightShiftStart = Math.max(clockInMinutes, regularOvertimeEnd)
    const nightShiftEndTime = Math.min(clockOutMinutes, nightShiftEnd)

    if (nightShiftEndTime > nightShiftStart) {
      const nightShiftHours = calculateContinuousOvertimeHours(nightShiftStart, nightShiftEndTime)
      totalOvertimeHours += nightShiftHours
      segmentBreakdown.nightShiftSegment = nightShiftHours

      statisticsData.nightShiftHours = nightShiftHours
      console.log(`- Night shift segment: ${nightShiftHours} hours`)
    }
  }

  // Extended night segment (beyond 06:00)
  if (clockOutMinutes > nightShiftEnd) {
    const extendedNightStart = nightShiftEnd
    const extendedNightEnd = clockOutMinutes

    const extendedNightHours = calculateContinuousOvertimeHours(extendedNightStart, extendedNightEnd)
    totalOvertimeHours += extendedNightHours
    segmentBreakdown.extendedNightSegment = extendedNightHours

    console.log(`- Extended night segment: ${extendedNightHours} hours`)
    console.log(`- WARNING: Work extended beyond 6:00 AM`)
  }

  // Update detailed statistics
  statisticsData.sessionStartMinutes = eveningStart
  statisticsData.sessionEndMinutes = clockOutMinutes
  statisticsData.eveningSegmentHours = segmentBreakdown.eveningSegment
  statisticsData.nightShiftSegmentHours = segmentBreakdown.nightShiftSegment
  statisticsData.extendedNightSegmentHours = segmentBreakdown.extendedNightSegment
  statisticsData.specialNotes = `Continuous evening work: ${segmentBreakdown.eveningSegment}h evening + ${segmentBreakdown.nightShiftSegment}h night + ${segmentBreakdown.extendedNightSegment}h extended = ${totalOvertimeHours}h total`

  console.log(`=== CONTINUOUS EVENING STATS COMPLETE: ${totalOvertimeHours} hours ===`)
  return totalOvertimeHours
}

function calculateOriginalEveningSessionWithStats(clockInMinutes, clockOutMinutes, sessionGracePeriod, statisticsData) {
  const eveningStart = 17 * 60 // 17:00
  const eveningGraceEnd = eveningStart + sessionGracePeriod // 17:15
  const firstHourEnd = eveningStart + 60 // 18:00

  let totalHours = 0
  let firstHourCredit = 0
  let latenessMinutes = 0

  // Calculate first hour with grace period
  if (clockInMinutes <= eveningGraceEnd) {
    firstHourCredit = 1
    statisticsData.gracePeriodApplied = true
    console.log(`- Clock in <= 17:15 (grace period) → First hour credit: 1.0`)
  } else if (clockInMinutes < firstHourEnd) {
    firstHourCredit = 0.5
    latenessMinutes = clockInMinutes - eveningGraceEnd
    console.log(`- Clock in 17:16-17:59 (late by ${latenessMinutes} min) → First hour credit: 0.5`)
  } else {
    firstHourCredit = 0
    latenessMinutes = clockInMinutes - eveningGraceEnd
    console.log(`- Clock in >= 18:00 (late by ${latenessMinutes} min) → First hour credit: 0`)
  }

  totalHours += firstHourCredit

  // Calculate additional hours after 18:00 using EVENING-SPECIFIC ROUNDING RULE
  let additionalHours = 0
  if (clockOutMinutes > firstHourEnd) {
    const remainingStart = Math.max(clockInMinutes, firstHourEnd)
    const remainingMinutes = clockOutMinutes - remainingStart

    if (remainingMinutes > 0) {
      console.log(`- Remaining time after 18:00: ${remainingMinutes} minutes`)

      // EVENING SESSION SPECIFIC RULE:
      // 25-55 minutes = 0.5 hours
      // 56+ minutes = 1 hour  
      // 0-24 minutes = no addition
      const wholeHours = Math.floor(remainingMinutes / 60)
      const remainingFraction = remainingMinutes % 60

      additionalHours = wholeHours

      if (remainingFraction >= 56) {
        additionalHours += 1
        console.log(`- Added 1.0 hour for ${remainingFraction} remaining minutes (>=56 min evening rule)`)
      } else if (remainingFraction >= 25) {
        additionalHours += 0.5
        console.log(`- Added 0.5 hours for ${remainingFraction} remaining minutes (25-55 min evening rule)`)
      } else if (remainingFraction > 0) {
        console.log(`- ${remainingFraction} remaining minutes < 25 - no addition (evening rule)`)
      }

      totalHours += additionalHours
      console.log(`- Additional hours after 18:00 with evening rule: ${additionalHours}`)
    }
  }

  // Update statistics
  statisticsData.sessionStartMinutes = eveningStart
  statisticsData.sessionEndMinutes = clockOutMinutes
  statisticsData.latenessMinutes = latenessMinutes
  statisticsData.firstHourCredit = firstHourCredit
  statisticsData.additionalHours = additionalHours
  statisticsData.specialNotes = `Evening session with special rounding: first=${firstHourCredit}, additional=${additionalHours}, total=${totalHours}`

  console.log(`- EVENING SESSION WITH SPECIAL ROUNDING: ${totalHours} hours`)
  return totalHours
}

// Updated helper function to handle 24+ hour formatting
function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60

  // Handle next day display
  if (hours >= 24) {
    const displayHours = hours - 24
    return `${displayHours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")} (+1 day)`
  }

  return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`
}

function isLate(clockType, clockTime) {
  const hour = clockTime.getHours()
  const minute = clockTime.getMinutes()
  const totalMinutes = hour * 60 + minute

  const earlyMorningStart = 6 * 60 // 6:00 AM - new early morning boundary
  const morningStart = 8 * 60 // 8:00 AM
  const afternoonStart = 13 * 60 // 1:00 PM
  const gracePeriod = 5 // 5 minutes

  console.log(`Late check: ${clockType} at ${hour}:${minute.toString().padStart(2, "0")} (${totalMinutes} minutes)`)

  if (clockType === "morning_in") {
    // Special case for early morning shift (6:00-12:00)
    if (totalMinutes >= earlyMorningStart && totalMinutes <= earlyMorningStart + gracePeriod) {
      console.log(
        `Early morning threshold: ${earlyMorningStart + gracePeriod} minutes (6:05 AM), Result: ON TIME (early morning rule)`,
      )
      return false
    }

    const isEmployeeLate = totalMinutes > morningStart + gracePeriod
    console.log(
      `Morning threshold: ${morningStart + gracePeriod} minutes (8:05 AM), Result: ${isEmployeeLate ? "LATE" : "ON TIME"}`,
    )
    return isEmployeeLate
  } else if (clockType === "afternoon_in") {
    const isEmployeeLate = totalMinutes > afternoonStart + gracePeriod
    console.log(
      `Afternoon threshold: ${afternoonStart + gracePeriod} minutes (1:05 PM), Result: ${isEmployeeLate ? "LATE" : "ON TIME"}`,
    )
    return isEmployeeLate
  }

  return false
}

function determineClockType(lastClockType, currentTime, lastClockTime = null, employeeUid = null, db = null) {
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
  console.log(`Parsed time: ${hour}:${minute.toString().padStart(2, "0")} (${totalMinutes} minutes from midnight)`)
  console.log(`Last clock type: ${lastClockType}`)
  console.log(`Evening start threshold: ${eveningStart} minutes (5:15 PM)`)
  console.log(`Afternoon end: ${afternoonEnd} minutes (5:00 PM)`)

  // Check if this might be an overnight shift continuation
  const isEarlyMorning = totalMinutes < earlyMorningEnd // Before 8:00 AM
  const isPossibleOvernightOut = isEarlyMorning && lastClockType && lastClockType.includes("_in")

  console.log(`Early morning check: ${isEarlyMorning}, Possible overnight out: ${isPossibleOvernightOut}`)

  // CRITICAL FIX: Check for overnight shifts with time validation
  if (lastClockTime && isPossibleOvernightOut) {
    const lastClockHour = lastClockTime.getHours()
    const lastClockMinutes = lastClockHour * 60 + lastClockTime.getMinutes()
    const currentClockMinutes = totalMinutes

    // If last clock was late in the evening/night (after 17:00) and current is early morning (before 8:00)
    // This indicates an overnight shift continuation
    if (lastClockMinutes >= afternoonEnd && currentClockMinutes < earlyMorningEnd) {
      console.log(
        `OVERNIGHT SHIFT DETECTED: Last clock at ${lastClockHour}:${lastClockTime.getMinutes().toString().padStart(2, "0")} (${lastClockMinutes} min), Current at ${hour}:${minute.toString().padStart(2, "0")} (${currentClockMinutes} min)`,
      )

      // Return the corresponding out type for the overnight shift
      const overtimeOutType = lastClockType.replace("_in", "_out")
      console.log(`Overnight shift continuation: ${lastClockType} → ${overtimeOutType}`)
      return overtimeOutType
    }
  }

  // NEW RULE: Special handling for 17:00 (5:00 PM) clock-ins when user hasn't had any sessions today
  if (totalMinutes >= afternoonEnd && totalMinutes < eveningStart && employeeUid && db) {
    // Exactly 17:00
    console.log(`=== SPECIAL 17:00 RULE CHECK ===`)
    console.log(`Clock-in at exactly 17:00 - checking for prior sessions today`)

    try {
      const today = safeCurrentTime.toISOString().split("T")[0]

      // Check if employee has any completed sessions today
      const sessionCheckQuery = db.prepare(`
        SELECT COUNT(*) as session_count
        FROM attendance 
        WHERE employee_uid = ? 
          AND date = ?
          AND clock_type LIKE '%_out'
      `)

      const sessionResult = sessionCheckQuery.get(employeeUid, today)
      const hasCompletedSessions = sessionResult && sessionResult.session_count > 0

      // Also check for any pending clock-ins today
      const pendingCheckQuery = db.prepare(`
        SELECT COUNT(*) as pending_count
        FROM attendance 
        WHERE employee_uid = ? 
          AND date = ?
          AND clock_type LIKE '%_in'
          AND id NOT IN (
            SELECT a1.id FROM attendance a1
            JOIN attendance a2 ON a1.employee_uid = a2.employee_uid
            WHERE a1.clock_type LIKE '%_in' 
              AND a2.clock_type = REPLACE(a1.clock_type, '_in', '_out')
              AND a2.clock_time > a1.clock_time
              AND a1.employee_uid = ?
              AND a1.date = ?
          )
      `)

      const pendingResult = pendingCheckQuery.get(employeeUid, today, employeeUid, today)
      const hasPendingClockIns = pendingResult && pendingResult.pending_count > 0

      console.log(`Sessions today: ${sessionResult?.session_count || 0}`)
      console.log(`Pending clock-ins: ${pendingResult?.pending_count || 0}`)
      console.log(`Has completed sessions: ${hasCompletedSessions}`)
      console.log(`Has pending clock-ins: ${hasPendingClockIns}`)

      // If no sessions today and no pending clock-ins, treat 17:00 as evening_in
      if (!hasCompletedSessions && !hasPendingClockIns) {
        console.log(`✓ SPECIAL RULE APPLIED: No prior sessions today - 17:00 clock-in treated as evening_in`)
        console.log(`=== END SPECIAL 17:00 RULE CHECK ===`)
        return "evening_in"
      } else {
        console.log(`✗ SPECIAL RULE NOT APPLIED: User has prior sessions/pending clock-ins today`)
        console.log(`=== END SPECIAL 17:00 RULE CHECK ===`)
        // Continue with normal logic below
      }
    } catch (error) {
      console.error("Error checking sessions for 17:00 rule:", error)
      console.log(`Database error - falling back to normal 17:00 logic`)
      // Fall back to normal logic if database check fails
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

  // Helper function to format time for logging
  function formatTime(minutes) {
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`
  }

  console.log(`Processing sequence based on last clock: ${lastClockType}`)

  switch (lastClockType) {
    case "morning_in":
      // Check if this is an overnight shift (morning_in followed by early morning time)
      if (isPossibleOvernightOut) {
        console.log(
          `morning_in + early morning time (${totalMinutes} < ${earlyMorningEnd}) → morning_out (overnight shift)`,
        )
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
        console.log(
          `afternoon_in + early morning time (${totalMinutes} < ${earlyMorningEnd}) → afternoon_out (overnight shift)`,
        )
        return "afternoon_out"
      }
      console.log(`afternoon_in → afternoon_out`)
      return "afternoon_out"

    case "afternoon_out":
      console.log(`=== AFTERNOON_OUT LOGIC ===`)

      // Check if this is the same day as the last clock
      const isSameDay =
        lastClockTime && lastClockTime.toISOString().split("T")[0] === safeCurrentTime.toISOString().split("T")[0]

      console.log(`Same day check: ${isSameDay}`)
      console.log(`Last clock time: ${lastClockTime?.toISOString()}`)
      console.log(`Current time: ${safeCurrentTime.toISOString()}`)

      if (isSameDay) {
        // Same day - any clock in after afternoon_out should be evening_in
        console.log(`Same day after afternoon_out → evening_in`)
        return "evening_in"
      } else {
        // Different day - determine by current time
        if (totalMinutes >= eveningStart) {
          console.log(`Different day + evening time → evening_in`)
          return "evening_in"
        }
        const nextClockType = hour < 12 ? "morning_in" : "afternoon_in"
        console.log(`Different day + not evening time → ${nextClockType}`)
        return nextClockType
      }

    case "evening_in":
      // Evening session can go overnight - check for early morning clock out
      if (isPossibleOvernightOut) {
        console.log(
          `evening_in + early morning time (${totalMinutes} < ${earlyMorningEnd}) → evening_out (overnight shift)`,
        )
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
        console.log(
          `overtime_in + early morning time (${totalMinutes} < ${earlyMorningEnd}) → overtime_out (overnight shift)`,
        )
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
      const { getDatabase } = require("./setup")
      database = getDatabase()
    } catch (error) {
      console.error("Cannot get database connection:", error)
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
      console.log(
        `Found pending clock-in for employee ${employeeUid}: ${pendingClock.clock_type} at ${pendingClock.clock_time}`,
      )
      return {
        id: pendingClock.id,
        clockType: pendingClock.clock_type,
        clockTime: new Date(pendingClock.clock_time),
        date: pendingClock.date,
        expectedClockOut: pendingClock.clock_type.replace("_in", "_out"),
        regularHours: pendingClock.regular_hours || 0,
        overtimeHours: pendingClock.overtime_hours || 0,
      }
    }

    return null
  } catch (error) {
    console.error("Error checking for pending clock-out:", error)
    return null
  }
}

// Helper function to get today's completed sessions for an employee
function getTodaysCompletedSessions(employeeUid, date = null, db = null) {
  let database = db
  if (!database) {
    try {
      const { getDatabase } = require("./setup")
      database = getDatabase()
    } catch (error) {
      console.error("Cannot get database connection:", error)
      return []
    }
  }

  const targetDate = date || new Date().toISOString().split("T")[0]

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

    return sessions.map((session) => ({
      clockType: session.clock_type,
      clockTime: new Date(session.clock_time),
      regularHours: session.regular_hours || 0,
      overtimeHours: session.overtime_hours || 0,
    }))
  } catch (error) {
    console.error("Error getting completed sessions:", error)
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
      const { getDatabase } = require("./setup")
      database = getDatabase()
    } catch (error) {
      console.error("Cannot get database connection for statistics:", error)
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
      calculationData.sessionType || "unknown",
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
      calculationData.calculationMethod || "unknown",
      calculationData.specialNotes || null,
      calculationData.date || new Date().toISOString().split("T")[0],
    )

    console.log(`✓ Statistics saved with ID: ${result.lastInsertRowid}`)
    console.log(`=== END SAVING STATISTICS ===`)

    return result.lastInsertRowid
  } catch (error) {
    console.error("Error saving attendance statistics:", error)
    return null
  }
}

/**
 * Enhanced calculateHours function that also saves statistics
 * This replaces your existing calculateHours function
 */
function calculateHoursWithStats(
  clockType,
  clockTime,
  clockInTime = null,
  employeeUid = null,
  attendanceId = null,
  clockOutId = null,
  db = null,
) {
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
    calculationMethod: "unknown",
    specialNotes: null,
    date: new Date().toISOString().split("T")[0],
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
      statisticsData.calculationMethod = "clock_in_only"
      break

    case "morning_out":
      if (clockInTime) {
        console.log(`Processing morning_out with continuous hours calculation`)
        const result = calculateContinuousHoursWithStats(clockInTime, clockTime, "morning", statisticsData)
        regularHours = result.regularHours
        overtimeHours = result.overtimeHours
        console.log(`Morning session result: Regular=${regularHours}, Overtime=${overtimeHours}`)
      } else {
        console.log(`WARNING: morning_out without clockInTime`)
        statisticsData.specialNotes = "WARNING: morning_out without clockInTime"
      }
      break

    case "afternoon_out":
      if (clockInTime) {
        console.log(`Processing afternoon_out with continuous hours calculation`)
        const result = calculateContinuousHoursWithStats(clockInTime, clockTime, "afternoon", statisticsData)
        regularHours = result.regularHours
        overtimeHours = result.overtimeHours
        console.log(`Afternoon session result: Regular=${regularHours}, Overtime=${overtimeHours}`)
      } else {
        console.log(`WARNING: afternoon_out without clockInTime`)
        statisticsData.specialNotes = "WARNING: afternoon_out without clockInTime"
      }
      break

    case "evening_out":
      if (clockInTime) {
        console.log(`Processing evening_out with session hours calculation`)
        // Evening sessions are ALWAYS overtime
        overtimeHours = calculateEveningSessionHoursWithStats(
          clockInTime,
          clockTime,
          overtimeSessionGracePeriod,
          statisticsData,
        )
        statisticsData.specialNotes = (statisticsData.specialNotes || "") + " Evening session - always overtime"
        console.log(`Evening session result: Overtime=${overtimeHours}`)
      } else {
        console.log(`WARNING: evening_out without clockInTime`)
        statisticsData.specialNotes = "WARNING: evening_out without clockInTime"
      }
      break

    case "overtime_out":
      if (clockInTime) {
        console.log(`Processing overtime_out with session hours calculation`)
        // Overtime sessions are ALWAYS overtime
        overtimeHours = calculateOvertimeSessionHoursWithStats(
          clockInTime,
          clockTime,
          overtimeSessionGracePeriod,
          statisticsData,
        )
        statisticsData.specialNotes = (statisticsData.specialNotes || "") + " Overtime session - always overtime"
        console.log(`Overtime session result: Overtime=${overtimeHours}`)
      } else {
        console.log(`WARNING: overtime_out without clockInTime`)
        statisticsData.specialNotes = "WARNING: overtime_out without clockInTime"
      }
      break

    default:
      console.log(`Unknown clock type: ${clockType}`)
      statisticsData.specialNotes = `Unknown clock type: ${clockType}`
      break
  }

  // Update statistics before applying any rules
  statisticsData.regularHours = regularHours
  statisticsData.overtimeHours = overtimeHours

  if (clockInTime && clockTime) {
    const clockInMinutes = clockInTime.getHours() * 60 + clockInTime.getMinutes()
    let clockOutMinutes = clockTime.getHours() * 60 + clockTime.getMinutes()

    if (clockOutMinutes < clockInMinutes) {
      clockOutMinutes += 24 * 60
      statisticsData.overnightShift = true
    }

    statisticsData.totalMinutesWorked = clockOutMinutes - clockInMinutes
    statisticsData.effectiveClockInMinutes = clockInMinutes
    statisticsData.effectiveClockOutMinutes = clockOutMinutes
  }

  // FIXED: Only apply 8-hour regular rule to morning/afternoon sessions
  let adjustedHours = { regularHours, overtimeHours }
  
  if (clockType === "morning_out" || clockType === "afternoon_out") {
    console.log(`Applying 8-hour regular rule for ${clockType}`)
    adjustedHours = apply8HourRegularRule(regularHours, overtimeHours)
    statisticsData.specialNotes = (statisticsData.specialNotes || "") + " 8-hour regular rule applied"
  } else {
    console.log(`Skipping 8-hour regular rule for ${clockType} - keeping as overtime`)
    statisticsData.specialNotes = (statisticsData.specialNotes || "") + " 8-hour rule skipped - pure overtime session"
  }

  const finalResult = {
    regularHours: Math.round(adjustedHours.regularHours * 100) / 100,
    overtimeHours: Math.round(adjustedHours.overtimeHours * 100) / 100,
  }

  // Update final statistics
  statisticsData.regularHours = finalResult.regularHours
  statisticsData.overtimeHours = finalResult.overtimeHours

  console.log(`=== FINAL CALCULATION RESULT ===`)
  console.log(`Regular Hours: ${finalResult.regularHours}`)
  console.log(`Overtime Hours: ${finalResult.overtimeHours}`)
  console.log(`Total Hours: ${finalResult.regularHours + finalResult.overtimeHours}`)

  // Save statistics if we have the required IDs
  if (employeeUid && clockOutId && clockType.includes("_out")) {
    console.log(`Saving statistics for employee ${employeeUid}...`)
    saveAttendanceStatistics(employeeUid, attendanceId, clockOutId, statisticsData, db)
  }

  return finalResult
}

/**
 * Enhanced continuous hours calculation that tracks statistics
 */
function calculateContinuousHoursWithStats(clockInTime, clockOutTime, startingSession, statisticsData) {
  const safeClockInTime = clockInTime instanceof Date ? clockInTime : new Date(clockInTime)
  const safeClockOutTime = clockOutTime instanceof Date ? clockOutTime : new Date(clockOutTime)
  const clockInMinutes = safeClockInTime.getHours() * 60 + safeClockInTime.getMinutes()
  let clockOutMinutes = clockOutTime.getHours() * 60 + safeClockOutTime.getMinutes()

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
  statisticsData.calculationMethod = "Regular Hours"

  // Working hours boundaries
  const earlyMorningStart = 6 * 60 // 6:00 AM - new early morning boundary
  const morningStart = 8 * 60 // 8:00 AM
  const morningEnd = 12 * 60 // 12:00 PM
  const lunchStart = 12 * 60 // 12:00 PM (lunch break start)
  const lunchEnd = 13 * 60 // 1:00 PM (lunch break end)
  const afternoonStart = 13 * 60 // 1:00 PM
  const afternoonEnd = 17 * 60 // 5:00 PM
  const overtimeEnd = 22 * 60 // 10:00 PM (end of regular overtime)
  const nightShiftEnd = 6 * 60 + 24 * 60 // 6:00 AM next day
  const regularGracePeriod = 5 // 5 minutes grace per hour for regular hours
  const earlyMorningGracePeriod = 5 // Keep original 5 minutes for early morning

  let totalRegularHours = 0
  let totalOvertimeHours = 0

  console.log(`=== CONTINUOUS HOURS CALCULATION WITH STATS ===`)
  console.log(`Clock in: ${formatMinutes(clockInMinutes)} (${clockInMinutes} min)`)
  console.log(`Clock out: ${formatMinutes(clockOutMinutes)} (${clockOutMinutes} min)`)
  console.log(`Starting session: ${startingSession}`)

  // Update statistics with session boundaries
  statisticsData.sessionStartMinutes = startingSession === "morning" ? morningStart : afternoonStart
  statisticsData.sessionEndMinutes = startingSession === "morning" ? morningEnd : afternoonEnd
  statisticsData.gracePeriodMinutes = regularGracePeriod

  // NEW ENHANCED EARLY MORNING RULE (6:00-8:00 only for overtime portion)
  // Rule applies if: morning session + clock in between 6:00-8:00
  const earlyMorningGraceStart = earlyMorningStart - earlyMorningGracePeriod // 5:55 AM
  let earlyMorningOvertimeHours = 0

  if (startingSession === "morning" && clockInMinutes >= earlyMorningGraceStart && clockInMinutes < morningStart) {
    // Must be before 8:00 AM to qualify for early morning overtime

    console.log(`=== EARLY MORNING OVERTIME CALCULATION (6:00-8:00) ===`)
    console.log(`Clock in: ${formatMinutes(clockInMinutes)} (qualifies for early morning overtime)`)

    statisticsData.earlyMorningRuleApplied = true
    statisticsData.specialNotes = "Early morning overtime rule applied (6:00-8:00 AM)"

    // Calculate overtime hours for the 6:00-8:00 AM period only
    if (clockInMinutes <= earlyMorningStart + earlyMorningGracePeriod) {
      // Up to 6:05 AM
      console.log(`=== EARLY MORNING OVERTIME: On-time for 6:00 AM ===`)
      console.log(`Clock in within 6:00 AM grace period: ${formatMinutes(clockInMinutes)} <= 6:05 AM`)
      console.log(`Awarding 2 overtime hours for 6:00-8:00 AM period`)

      // Award 2 overtime hours for the 6:00-8:00 AM period
      earlyMorningOvertimeHours = 2
      statisticsData.gracePeriodApplied = true
    } else {
      // Apply 30-minute rule for late early morning shifts (same as before)
      console.log(`=== EARLY MORNING OVERTIME: Late arrival ===`)
      console.log(`Clock in after 6:05 AM: ${formatMinutes(clockInMinutes)}`)

      // Check each hour in the 6:00-8:00 AM period with 30-minute rule
      let calculatedOvertimeHours = 0
      let hour1OvertimeHours = 0
      let hour2OvertimeHours = 0

      // Hour 1: 6:00-7:00 AM
      const hour1Start = 6 * 60 // 6:00 AM
      const hour1End = 7 * 60 // 7:00 AM
      const lateForHour1 = Math.max(0, clockInMinutes - hour1Start)

      console.log(`Hour 1 (6:00-7:00): Late by ${lateForHour1} minutes`)

      if (clockInMinutes < hour1End) {
        // Clocked in before 7:00 AM
        if (lateForHour1 <= 30) {
          // Within 30-minute rule
          if (lateForHour1 <= regularGracePeriod) {
            hour1OvertimeHours = 1 // On time, full hour
            console.log(`Hour 1: 1.0 overtime hour (on time)`)
          } else {
            hour1OvertimeHours = 0.5 // Late but within 30 min, half hour
            console.log(`Hour 1: 0.5 overtime hour (late 6-30 min)`)
          }
        } else {
          console.log(`Hour 1: 0 overtime hours (>30 min late - VOID)`)
        }
      } else {
        console.log(`Hour 1: 0 overtime hours (missed entirely)`)
      }

      calculatedOvertimeHours += hour1OvertimeHours

      // Hour 2: 7:00-8:00 AM
      const hour2Start = 7 * 60 // 7:00 AM
      const hour2End = 8 * 60 // 8:00 AM
      const lateForHour2 = Math.max(0, clockInMinutes - hour2Start)

      console.log(`Hour 2 (7:00-8:00): Late by ${lateForHour2} minutes`)

      if (clockInMinutes < hour2End) {
        // Clocked in before 8:00 AM
        if (lateForHour2 <= regularGracePeriod) {
          hour2OvertimeHours = 1 // On time (within 5 min grace), full hour
          console.log(`Hour 2: 1.0 overtime hour (on time - within ${regularGracePeriod} min grace)`)
        } else if (lateForHour2 < 30) {
          // Less than 30 minutes
          hour2OvertimeHours = 0.5 // Late 6-29 min, half hour
          console.log(`Hour 2: 0.5 overtime hour (late ${lateForHour2} min - between 6-29 min)`)
        } else {
          console.log(`Hour 2: 0 overtime hours (${lateForHour2} min late - >=30 min VOID)`)
        }
      } else {
        console.log(`Hour 2: 0 overtime hours (missed entirely)`)
      }

      calculatedOvertimeHours += hour2OvertimeHours
      earlyMorningOvertimeHours = calculatedOvertimeHours

      // Update statistics for detailed breakdown
      statisticsData.earlyMorningHour1Hours = hour1OvertimeHours
      statisticsData.earlyMorningHour2Hours = hour2OvertimeHours
      statisticsData.lateArrivalMinutes = Math.max(lateForHour1, 0)

      console.log(`Late early morning overtime calculation: ${calculatedOvertimeHours} overtime hours`)
    }

    totalOvertimeHours += earlyMorningOvertimeHours
    statisticsData.earlyArrivalOvertimeHours = earlyMorningOvertimeHours
    console.log(`Early morning overtime hours added: ${earlyMorningOvertimeHours}`)
    console.log(`=== END EARLY MORNING OVERTIME CALCULATION ===`)
  }

  // Continue with regular hours calculation for the full day
  if (startingSession === "morning") {
    // Calculate morning hours (8:00-12:00) - regardless of early morning rule
    if (clockInMinutes < morningEnd && clockOutMinutes > morningStart) {
      const morningStartTime = Math.max(clockInMinutes, morningStart)
      const morningEndTime = Math.min(clockOutMinutes, morningEnd)

      if (morningEndTime > morningStartTime) {
        const morningHours = calculateRegularHours(
          new Date(0, 0, 0, Math.floor(morningStartTime / 60), morningStartTime % 60),
          new Date(0, 0, 0, Math.floor(morningEndTime / 60), morningEndTime % 60),
          morningStart,
          morningEnd,
          regularGracePeriod,
        )
        totalRegularHours += morningHours
        statisticsData.morningSessionHours = morningHours
        console.log(
          `Morning hours (${formatMinutes(morningStartTime)} - ${formatMinutes(morningEndTime)}): ${morningHours}`,
        )
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
          regularGracePeriod,
        )
        totalRegularHours += afternoonHours
        statisticsData.afternoonSessionHours = afternoonHours
        console.log(
          `Afternoon hours (${formatMinutes(afternoonStartTime)} - ${formatMinutes(afternoonEndTime)}): ${afternoonHours}`,
        )
      }
    }

    // Calculate regular overtime hours (17:00-22:00)
    if (clockOutMinutes > afternoonEnd) {
      const regularOvertimeStart = afternoonEnd
      const regularOvertimeEnd = Math.min(clockOutMinutes, overtimeEnd)

      if (regularOvertimeEnd > regularOvertimeStart) {
        const regularOvertimeHours = calculateSimpleOvertimeHours(regularOvertimeStart, regularOvertimeEnd)
        totalOvertimeHours += regularOvertimeHours
        statisticsData.regularOvertimeHours = regularOvertimeHours
        console.log(
          `Regular overtime hours (${formatMinutes(regularOvertimeStart)} - ${formatMinutes(regularOvertimeEnd)}): ${regularOvertimeHours}`,
        )
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

        // Add special note for night shift work
        const nightShiftMinutes = nightShiftEndTime - nightShiftStart
        if (nightShiftMinutes <= 30) {
          statisticsData.specialNotes =
            (statisticsData.specialNotes || "") +
            ` Worked ${nightShiftMinutes} minutes into night shift (22:00-${formatMinutes(nightShiftEndTime)})`
        } else {
          statisticsData.specialNotes =
            (statisticsData.specialNotes || "") +
            ` Extended night shift work: ${formatMinutes(nightShiftStart)} - ${formatMinutes(nightShiftEndTime)}`
        }

        console.log(
          `Night shift overtime hours (${formatMinutes(nightShiftStart)} - ${formatMinutes(nightShiftEndTime)}): ${nightShiftHours}`,
        )
      }
    }

    // Handle lunch break logging
    if (clockInMinutes < lunchStart && clockOutMinutes > lunchEnd) {
      statisticsData.lunchBreakExcluded = true
      console.log(`Lunch break excluded: ${formatMinutes(lunchStart)} - ${formatMinutes(lunchEnd)} (1 hour)`)
    } else if (clockInMinutes < lunchStart && clockOutMinutes > lunchStart && clockOutMinutes <= lunchEnd) {
      statisticsData.specialNotes =
        (statisticsData.specialNotes || "") + " Clocked out during lunch break - no afternoon hours counted"
      console.log(`Clocked out during lunch break - no afternoon hours counted`)
    }
  } else if (startingSession === "afternoon") {
    // For afternoon sessions, if they clocked in during lunch (12:00-13:00), treat as 13:00
    let effectiveAfternoonClockIn = clockInMinutes
    if (clockInMinutes < afternoonStart && clockInMinutes >= lunchStart) {
      effectiveAfternoonClockIn = afternoonStart // Lunch break - start counting from 13:00
      statisticsData.specialNotes = "Clock in during lunch break - treating as 13:00 for calculation"
      console.log(`Clock in during lunch break (${formatMinutes(clockInMinutes)}) - treating as 13:00 for calculation`)
    }

    // Check for early afternoon arrival (before 13:00, but not during lunch)
    if (clockInMinutes < lunchStart) {
      // This is very early afternoon clock-in (before 12:00) - count as early arrival overtime
      const earlyAfternoonEnd = Math.min(clockOutMinutes, afternoonStart)
      if (earlyAfternoonEnd > clockInMinutes) {
        const earlyAfternoonOvertime = calculateSimpleOvertimeHours(clockInMinutes, earlyAfternoonEnd)
        totalOvertimeHours += earlyAfternoonOvertime
        statisticsData.earlyArrivalMinutes = earlyAfternoonEnd - clockInMinutes
        statisticsData.earlyArrivalOvertimeHours = earlyAfternoonOvertime
        console.log(
          `Early afternoon arrival overtime (${formatMinutes(clockInMinutes)} - ${formatMinutes(earlyAfternoonEnd)}): ${earlyAfternoonOvertime} hours`,
        )
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
          regularGracePeriod,
        )
        totalRegularHours += afternoonHours
        statisticsData.afternoonSessionHours = afternoonHours
        console.log(
          `Afternoon hours (${formatMinutes(afternoonStartTime)} - ${formatMinutes(afternoonEndTime)}): ${afternoonHours}`,
        )
      }
    }

    // Calculate regular overtime hours (17:00-22:00)
    if (clockOutMinutes > afternoonEnd) {
      const regularOvertimeStart = afternoonEnd
      const regularOvertimeEnd = Math.min(clockOutMinutes, overtimeEnd)

      if (regularOvertimeEnd > regularOvertimeStart) {
        const regularOvertimeHours = calculateSimpleOvertimeHours(regularOvertimeStart, regularOvertimeEnd)
        totalOvertimeHours += regularOvertimeHours
        statisticsData.regularOvertimeHours = regularOvertimeHours
        console.log(
          `Regular overtime hours (${formatMinutes(regularOvertimeStart)} - ${formatMinutes(regularOvertimeEnd)}): ${regularOvertimeHours}`,
        )
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
        console.log(
          `Night shift overtime hours (${formatMinutes(nightShiftStart)} - ${formatMinutes(nightShiftEndTime)}): ${nightShiftHours}`,
        )
      }
    }
  }

  console.log(`=== CALCULATION SUMMARY ===`)
  console.log(`Early morning overtime (6:00-8:00): ${earlyMorningOvertimeHours} hours`)
  console.log(`Regular hours (8:00-12:00 + 13:00-17:00): ${totalRegularHours} hours`)
  console.log(`Other overtime hours: ${totalOvertimeHours - earlyMorningOvertimeHours} hours`)
  console.log(`Total regular hours: ${totalRegularHours}`)
  console.log(`Total overtime hours: ${totalOvertimeHours}`)
  console.log(`Grand total: ${totalRegularHours + totalOvertimeHours} hours`)
  console.log(`=== END CONTINUOUS CALCULATION WITH STATS ===`)

  return {
    regularHours: totalRegularHours,
    overtimeHours: totalOvertimeHours,
  }
}

/**
 * Enhanced overtime session calculation with statistics tracking
 */
function calculateOvertimeSessionHoursWithStats(clockInTime, clockOutTime, sessionGracePeriod, statisticsData) {

  const safeClockInTime = clockInTime instanceof Date ? clockInTime : new Date(clockInTime)
  const safeClockOutTime = clockOutTime instanceof Date ? clockOutTime : new Date(clockOutTime)
  const clockInMinutes = safeClockInTime.getHours() * 60 + safeClockInTime.getMinutes()
  let clockOutMinutes = safeClockOutTime.getHours() * 60 + safeClockOutTime.getMinutes()

  // Handle overnight shifts
  if (clockOutMinutes < clockInMinutes) {
    clockOutMinutes += 24 * 60
    statisticsData.overnightShift = true
  }

  const totalMinutesWorked = clockOutMinutes - clockInMinutes
  const effectiveMinutesWorked = Math.max(0, totalMinutesWorked - sessionGracePeriod)

  statisticsData.calculationMethod = "overtime_session"
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
  if (clockType.includes("morning")) return "morning"
  if (clockType.includes("afternoon")) return "afternoon"
  if (clockType.includes("evening")) return "evening"
  if (clockType.includes("overtime")) return "overtime"
  return "unknown"
}

/**
 * Get statistical summary for an employee on a specific date
 */
function getEmployeeStatistics(employeeUid, date = null, db = null) {
  let database = db
  if (!database) {
    try {
      const { getDatabase } = require("./setup")
      database = getDatabase()
    } catch (error) {
      console.error("Cannot get database connection:", error)
      return null
    }
  }

  const targetDate = date || new Date().toISOString().split("T")[0]

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
    const dailyTotals = stats.reduce(
      (acc, stat) => {
        acc.totalRegularHours += stat.regular_hours || 0
        acc.totalOvertimeHours += stat.overtime_hours || 0
        acc.totalMinutesWorked += stat.total_minutes_worked || 0
        acc.sessionsCount += 1

        if (stat.early_morning_rule_applied) acc.earlyMorningRuleCount += 1
        if (stat.overnight_shift) acc.overnightShiftCount += 1
        if (stat.grace_period_applied) acc.gracePeriodCount += 1

        return acc
      },
      {
        totalRegularHours: 0,
        totalOvertimeHours: 0,
        totalMinutesWorked: 0,
        sessionsCount: 0,
        earlyMorningRuleCount: 0,
        overnightShiftCount: 0,
        gracePeriodCount: 0,
      },
    )

    return {
      employee: {
        uid: employeeUid,
        name: `${stats[0].first_name} ${stats[0].last_name}`,
        idNumber: stats[0].id_number,
      },
      date: targetDate,
      sessions: stats,
      dailyTotals: {
        ...dailyTotals,
        totalHours: dailyTotals.totalRegularHours + dailyTotals.totalOvertimeHours,
      },
    }
  } catch (error) {
    console.error("Error getting employee statistics:", error)
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
  apply8HourRegularRule,
  //statistic
  calculateHoursWithStats,
  saveAttendanceStatistics,
  calculateContinuousHoursWithStats,
  calculateEveningSessionHoursWithStats,
  calculateOvertimeSessionHoursWithStats,
  getEmployeeStatistics,
  determineSessionType,
}
