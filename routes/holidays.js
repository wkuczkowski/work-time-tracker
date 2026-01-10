/**
 * Routes for holidays management in the Work Time Tracker application.
 * Handles all holiday tracking functionality including adding, deleting, and displaying holiday history.
 * Provides views for displaying holidays and statistics.
 */

const express = require("express");
const router = express.Router();
const { dbAsync } = require("../db/database");
const Holiday = require("../models/Holiday");
const PublicHoliday = require("../models/PublicHoliday");
const WorkLocation = require("../models/WorkLocation");
const User = require("../models/User");
const Group = require("../models/Group");
const {
  formatDate,
  formatDateForDisplay,
  getDayOfWeekName,
  formatDayAndMonthGenitive,
  getMonthDateRange,
} = require("../utils/dateUtils");
const { prepareMessages } = require("../utils/messageUtils");

// Helper function to generate dates between start and end date (inclusive)
const generateDateRange = (startDate, endDate, publicHolidays = []) => {
  const dates = [];
  const currentDate = new Date(startDate);
  const lastDate = new Date(endDate);

  // Create a Set of public holiday dates for faster lookup
  const publicHolidayDates = new Set(
    publicHolidays.map(ph => formatDate(ph.holiday_date))
  );

  // Add dates until we reach the end date
  while (currentDate <= lastDate) {
    const dayOfWeek = currentDate.getDay();
    const currentDateStr = formatDate(new Date(currentDate));
    
    // Skip weekends (0 = Sunday, 6 = Saturday) and public holidays
    if (dayOfWeek !== 0 && dayOfWeek !== 6 && !publicHolidayDates.has(currentDateStr)) {
      dates.push(currentDateStr);
    }
    currentDate.setDate(currentDate.getDate() + 1);
  }

  return dates;
};

// Display holidays page (planning future holidays)
router.get("/", async (req, res) => {
  try {
    // Get authenticated user ID
    const userId = req.user.id;
    const today = formatDate(new Date()); // Format as YYYY-MM-DD

    // Get future holidays for display in the list (all future holidays, not just current month)
    const futureHolidays = await Holiday.findFutureHolidays(userId, today);

    // Format holiday dates for display
    futureHolidays.forEach((holiday) => {
      holiday.holiday_date = formatDateForDisplay(holiday.holiday_date);
    });

    // Get user holidays for extended range (6 months back, 6 months forward) for calendar highlighting
    const todayDate = new Date();
    const sixMonthsAgo = new Date(todayDate.getFullYear(), todayDate.getMonth() - 6, 1);
    const sixMonthsAhead = new Date(todayDate.getFullYear(), todayDate.getMonth() + 7, 0);
    const allUserHolidays = await Holiday.findByUserAndDateRange(
      userId,
      formatDate(sixMonthsAgo),
      formatDate(sixMonthsAhead)
    );

    // Format dates for client-side comparison
    allUserHolidays.forEach((holiday) => {
      holiday.holiday_date = formatDate(holiday.holiday_date);
    });

    // Get public holidays for the next 2 years (for future date validation)
    const currentYear = new Date().getFullYear();
    const publicHolidaysCurrentYear = await PublicHoliday.findByYear(currentYear);
    const publicHolidaysNextYear = await PublicHoliday.findByYear(currentYear + 1);
    const allPublicHolidays = [...publicHolidaysCurrentYear, ...publicHolidaysNextYear];

    res.render("holidays/index", {
      title: "Planowanie urlopów",
      currentPage: "holidays",
      futureHolidays, // Pass future holidays for display
      allUserHolidays, // Pass extended range of user holidays for calendar highlighting
      publicHolidaysRaw: allPublicHolidays, // Pass broader range of public holidays for client-side validation
      isAuthenticated: req.oidc.isAuthenticated(),
      user: req.oidc.user,
      dbUser: req.user, // Pass database user
      messages: prepareMessages(req.query),
    });
  } catch (_error) {
    res.render("holidays/index", {
      title: "Planowanie urlopów",
      currentPage: "holidays",
      futureHolidays: [],
      allUserHolidays: [], // Pass empty array for extended user holidays in error case
      publicHolidaysRaw: [], // Pass empty array for broader public holidays in error case
      isAuthenticated: req.oidc.isAuthenticated(),
      user: req.oidc.user,
      dbUser: req.user, // Pass database user
      messages: { error: "Wystąpił błąd podczas ładowania danych" },
    });
  }
});

// Add holiday
router.post("/", async (req, res) => {
  try {
    // Get authenticated user ID
    const userId = req.user.id;
    const { start_date, end_date } = req.body;

    // Validate the start date (cannot be empty)
    if (!start_date) {
      return res.redirect("/holidays?error=invalid_date");
    }

    // Check if the start date is a weekend
    const startDayObj = new Date(start_date);
    const startDayOfWeek = startDayObj.getDay();
    if (startDayOfWeek === 0 || startDayOfWeek === 6) {
      return res.redirect("/holidays?error=weekend_not_allowed");
    }

    // If end_date is not provided, use start_date as the end date (single day)
    const actualEndDate = end_date || start_date;

    // Get public holidays for the date range
    const publicHolidays = await PublicHoliday.findByDateRange(start_date, actualEndDate);

    // Check if start date is a public holiday
    const startDateFormatted = formatDate(start_date);
    const isStartDatePublicHoliday = publicHolidays.some(
      ph => formatDate(ph.holiday_date) === startDateFormatted
    );
    if (isStartDatePublicHoliday) {
      return res.redirect("/holidays?error=public_holiday_not_allowed");
    }

    // Generate all dates in the range (weekends and public holidays are automatically excluded)
    const holidayDates = generateDateRange(start_date, actualEndDate, publicHolidays);

    // Check if any dates were generated (might be empty if only weekend days or public holidays)
    if (holidayDates.length === 0) {
      return res.redirect("/holidays?error=no_valid_days");
    }

    // Create holiday entries for each date in the range (using transaction for atomicity)
    await dbAsync.transaction(async (client) => {
      for (const holiday_date of holidayDates) {
        // Check if holiday already exists
        const existing = await client.query(
          "SELECT id FROM holidays WHERE user_id = $1 AND holiday_date = $2",
          [userId, holiday_date]
        );
        
        // Only insert if doesn't exist
        if (existing.rows.length === 0) {
          await client.query(
            "INSERT INTO holidays (user_id, holiday_date) VALUES ($1, $2)",
            [userId, holiday_date]
          );
        }
      }
    });

    const daysCount = holidayDates.length;
    let successMessage = daysCount > 1 ? `added_${daysCount}_days` : "added";

    // Check if date range includes weekends or public holidays to inform the user
    const startObj = new Date(start_date);
    const endObj = new Date(actualEndDate);
    const totalDayCount =
      Math.round((endObj - startObj) / (1000 * 60 * 60 * 24)) + 1;

    if (totalDayCount > daysCount) {
      // Check for weekends and public holidays in the excluded days
      let hasWeekends = false;
      let hasPublicHolidays = false;
      
      for (let i = 0; i < totalDayCount; i++) {
        const checkDate = new Date(startObj);
        checkDate.setDate(startObj.getDate() + i);
        const dayOfWeek = checkDate.getDay();
        const checkDateStr = formatDate(checkDate);
        
        if (dayOfWeek === 0 || dayOfWeek === 6) {
          hasWeekends = true;
        }
        if (publicHolidays.some(ph => formatDate(ph.holiday_date) === checkDateStr)) {
          hasPublicHolidays = true;
        }
      }
      
      if (hasWeekends && hasPublicHolidays) {
        successMessage += "_weekends_and_holidays_excluded";
      } else if (hasWeekends) {
        successMessage += "_weekends_excluded";
      } else if (hasPublicHolidays) {
        successMessage += "_holidays_excluded";
      }
    }

    res.redirect(`/holidays?success=${successMessage}`);
  } catch (_error) {
    res.redirect("/holidays?error=failed");
  }
});

// Delete holiday
router.post("/:id/delete", async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id; // Get authenticated user ID

    // Get the holiday entry
    const holidayEntry = await Holiday.findById(id);

    // Ensure user owns the entry and it exists
    if (!holidayEntry || holidayEntry.user_id !== userId) {
      // Check if user is admin, if so, allow deletion
      if (!req.user.isAdmin()) {
        return res.redirect("/holidays?error=not_found");
      }
    }

    // Delete the entry
    await holidayEntry.delete();

    res.redirect("/holidays?success=deleted");
  } catch (_error) {
    res.redirect("/holidays?error=failed");
  }
});

// Display holiday history for the user
router.get("/history", async (req, res) => {
  try {
    // Get authenticated user ID
    const userId = req.user.id;
    const today = formatDate(new Date()); // Format as YYYY-MM-DD

    // Get past holidays
    const pastHolidays = await Holiday.findPastHolidays(userId, today);

    // Group holidays by month
    const holidaysByMonth = {};
    pastHolidays.forEach((holiday) => {
      // Format the holiday date for display before grouping
      holiday.holiday_date = formatDateForDisplay(holiday.holiday_date);

      // Extract year and month from the holiday date
      const formattedDate = formatDate(holiday.holiday_date); // Use formatDate for reliable splitting
      const dateParts = formattedDate.split("-");
      const year = dateParts[0];
      const month = dateParts[1];
      const monthKey = `${year}-${month}`;

      // Create month group if it doesn't exist
      if (!holidaysByMonth[monthKey]) {
        // Get month name in Polish
        const date = new Date(year, parseInt(month) - 1, 1);
        const monthName = date.toLocaleString("pl-PL", { month: "long" });
        holidaysByMonth[monthKey] = {
          name: `${monthName} ${year}`,
          holidays: [],
        };
      }

      // Add holiday to the month group
      holidaysByMonth[monthKey].holidays.push(holiday);
    });

    res.render("holidays/history", {
      title: "Historia urlopów",
      currentPage: "holidays",
      holidaysByMonth,
      isAuthenticated: req.oidc.isAuthenticated(),
      user: req.oidc.user,
      dbUser: req.user, // Pass database user
      messages: prepareMessages(req.query),
    });
  } catch (_error) {
    res.render("holidays/history", {
      title: "Historia urlopów",
      currentPage: "holidays",
      holidaysByMonth: {},
      isAuthenticated: req.oidc.isAuthenticated(),
      user: req.oidc.user,
      dbUser: req.user,
      messages: { error: "Wystąpił błąd podczas ładowania historii urlopów" },
    });
  }
});

// Redirect /future to main holidays page (consolidated)
router.get("/future", (req, res) => {
  res.redirect("/holidays");
});

// Redirect /employees to /employees/by-date by default
router.get("/employees", (req, res) => {
  res.redirect("/holidays/employees/by-date");
});

// Display all employee holidays for the current month (grouped by date)
router.get("/employees/by-date", async (req, res) => {
  try {
    // Get month and year from query parameters or use current month
    const queryMonth = parseInt(req.query.month) || new Date().getMonth() + 1;
    const queryYear = parseInt(req.query.year) || new Date().getFullYear();
    
    // Validate month and year
    const month = Math.max(1, Math.min(12, queryMonth));
    const year = Math.max(2020, Math.min(2030, queryYear)); // Reasonable year range
    
    // Get date range for the specified month
    const { startDate, endDate } = getMonthDateRange(year, month);

    // Get all users
    const allUsers = await User.getAll();

    // Fetch all holidays for the date range in a single query (instead of N queries)
    const allHolidays = await Holiday.findAllByDateRange(startDate, endDate);

    // Group holidays by user_id for O(1) lookup
    const holidaysByUser = {};
    allHolidays.forEach((holiday) => {
      if (!holidaysByUser[holiday.user_id]) {
        holidaysByUser[holiday.user_id] = [];
      }
      holidaysByUser[holiday.user_id].push(holiday);
    });

    // Initialize an empty object to hold holidays grouped by date
    const holidaysByDate = {};

    // Process each user
    for (const user of allUsers) {
      // Get holidays for this user from the pre-fetched map
      const userHolidays = holidaysByUser[user.id] || [];

      // Process each holiday for this user
      for (const holiday of userHolidays) {
        const dateStr = formatDate(holiday.holiday_date);
        // Use the new formatter for the main date display
        const displayDate = formatDayAndMonthGenitive(holiday.holiday_date);
        const dayOfWeek = getDayOfWeekName(holiday.holiday_date);

        // Create entry for this date if it doesn't exist
        if (!holidaysByDate[dateStr]) {
          holidaysByDate[dateStr] = {
            date: displayDate, // Use newly formatted date
            day_of_week: dayOfWeek,
            employees: [],
          };
        }

        // Add this user to the employees for this date
        holidaysByDate[dateStr].employees.push({
          id: user.id,
          name: user.name || user.email.split("@")[0],
          email: user.email,
        });
      }
    }

    res.render("holidays/employees", {
      title: "Urlopy pracowników",
      currentPage: "holidays",
      month,
      year,
      holidaysByDate,
      users: allUsers,
      isAuthenticated: req.oidc.isAuthenticated(),
      user: req.oidc.user,
      dbUser: req.user,
      messages: prepareMessages(req.query),
      formatDateForDisplay,
      formatDayAndMonthGenitive,
      currentView: "by-date",
    });
  } catch (_error) {
    res.render("holidays/employees", {
      title: "Urlopy pracowników",
      currentPage: "holidays",
      month: new Date().getMonth() + 1,
      year: new Date().getFullYear(),
      holidaysByDate: {},
      users: [],
      isAuthenticated: req.oidc.isAuthenticated(),
      user: req.oidc.user,
      dbUser: req.user,
      messages: { error: "Wystąpił błąd podczas ładowania danych" },
      formatDateForDisplay: () => "",
      formatDayAndMonthGenitive: () => "",
      currentView: "by-date",
    });
  }
});

// Display all employee holidays for the current month (grouped by person)
router.get("/employees/by-person", async (req, res) => {
  try {
    // Get month and year from query parameters or use current month
    const queryMonth = parseInt(req.query.month) || new Date().getMonth() + 1;
    const queryYear = parseInt(req.query.year) || new Date().getFullYear();
    
    // Validate month and year
    const month = Math.max(1, Math.min(12, queryMonth));
    const year = Math.max(2020, Math.min(2030, queryYear)); // Reasonable year range
    
    // Get date range for the specified month
    const { startDate, endDate } = getMonthDateRange(year, month);

    const allUsers = await User.getAll();
    const allGroups = await Group.findAll();
    const publicHolidaysRaw = await PublicHoliday.findByMonthAndYear(
      month,
      year
    );

    // Fetch all holidays for the date range in a single query (instead of N queries)
    const allHolidays = await Holiday.findAllByDateRange(startDate, endDate);

    // Fetch all work locations for the date range in a single query
    const allWorkLocations = await WorkLocation.findAllByDateRange(startDate, endDate);

    // Group holidays by user_id for O(1) lookup
    const holidaysByUser = {};
    allHolidays.forEach((holiday) => {
      if (!holidaysByUser[holiday.user_id]) {
        holidaysByUser[holiday.user_id] = [];
      }
      holidaysByUser[holiday.user_id].push(holiday);
    });

    // Group work locations by user_id for O(1) lookup
    const workLocationsByUser = {};
    allWorkLocations.forEach((location) => {
      if (!workLocationsByUser[location.user_id]) {
        workLocationsByUser[location.user_id] = {};
      }
      workLocationsByUser[location.user_id][formatDate(location.work_date)] = location.is_onsite;
    });

    const publicHolidaysMap = {};
    publicHolidaysRaw.forEach((ph) => {
      publicHolidaysMap[formatDate(ph.holiday_date)] = ph.name;
    });

    const daysInMonth = [];
    const date = new Date(year, month - 1, 1);
    while (date.getMonth() === month - 1) {
      daysInMonth.push(formatDate(new Date(date)));
      date.setDate(date.getDate() + 1);
    }

    // Create group mapping similar to dashboard
    const groupMap = {};
    
    // Initialize group map with all groups
    allGroups.forEach((group) => {
      groupMap[group.id] = {
        id: group.id,
        name: group.name,
        employees: [],
      };
    });

    // Add "No Group" for users without a group
    groupMap[0] = {
      id: 0,
      name: "Bez grupy",
      employees: [],
    };

    // Process each user and group them
    for (const user of allUsers) {
      // Get holidays for this user from the pre-fetched map
      const userHolidays = holidaysByUser[user.id] || [];
      const holidayDates = userHolidays.map((h) => formatDate(h.holiday_date));

      // Get work locations for this user from the pre-fetched map
      const userWorkLocations = workLocationsByUser[user.id] || {};

      // Calculate remote work dates (excluding weekends, public holidays, and personal holidays)
      const remoteDates = [];
      for (const dateStr of daysInMonth) {
        const dateKey = dateStr.split('T')[0];
        const dayDate = new Date(dateStr);
        const dayOfWeek = dayDate.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const isPublicHoliday = publicHolidaysMap[dateKey];
        const isHoliday = holidayDates.includes(dateStr);
        const isRemote = userWorkLocations[dateKey] === false;

        // Only count remote work on working days (not weekend, not public holiday, not personal holiday)
        if (isRemote && !isWeekend && !isPublicHoliday && !isHoliday) {
          remoteDates.push(dateStr);
        }
      }

      // Include users with holidays OR remote work in the current month
      if (holidayDates.length > 0 || remoteDates.length > 0) {
        const employeeData = {
          id: user.id,
          name: user.name || user.email.split("@")[0],
          email: user.email,
          holidays: holidayDates,
          holidayCount: holidayDates.length,
          workLocations: userWorkLocations,
          remoteDates: remoteDates,
          remoteDaysCount: remoteDates.length,
        };

        // Add user to the appropriate group
        const groupId = user.group_id || 0; // Use 0 for users without a group
        groupMap[groupId].employees.push(employeeData);
      }
    }

    // Convert groupMap to array and sort groups, filter out empty groups
    const groupedEmployees = Object.values(groupMap)
      .filter((group) => group.employees.length > 0) // Only include groups with employees
      .sort((a, b) => {
        // Sort "No Group" to the end
        if (a.id === 0) return 1;
        if (b.id === 0) return -1;
        // Otherwise sort alphabetically
        return a.name.localeCompare(b.name);
      });

    // Calculate statistics for employees with holidays and remote work
    let totalEmployeesWithHolidays = 0;
    let totalEmployeesWithRemoteWork = 0;
    groupedEmployees.forEach(group => {
      group.employees.forEach(employee => {
        if (employee.holidayCount > 0) {
          totalEmployeesWithHolidays++;
        }
        if (employee.remoteDaysCount > 0) {
          totalEmployeesWithRemoteWork++;
        }
      });
    });

    res.render("holidays/employees-by-person", {
      title: "Urlopy pracowników - wg osoby",
      currentPage: "holidays",
      month,
      year,
      groupedEmployees,
      daysInMonth,
      publicHolidays: publicHolidaysMap,
      totalEmployeesWithHolidays,
      totalEmployeesWithRemoteWork,
      isAuthenticated: req.oidc.isAuthenticated(),
      user: req.oidc.user,
      dbUser: req.user,
      messages: prepareMessages(req.query),
      currentView: "by-person",
    });
  } catch (_error) {
    res.render("holidays/employees-by-person", {
      title: "Urlopy pracowników - wg osoby",
      currentPage: "holidays",
      month: new Date().getMonth() + 1,
      year: new Date().getFullYear(),
      groupedEmployees: [],
      daysInMonth: [],
      publicHolidays: {},
      totalEmployeesWithHolidays: 0,
      totalEmployeesWithRemoteWork: 0,
      isAuthenticated: req.oidc.isAuthenticated(),
      user: req.oidc.user,
      dbUser: req.user,
      messages: { error: "Wystąpił błąd podczas ładowania danych" },
      currentView: "by-person",
    });
  }
});

module.exports = router;
