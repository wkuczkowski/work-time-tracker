/**
 * Main application server file for the Work Time Tracker application.
 * Sets up Express, configures middleware, initializes database connection,
 * establishes Auth0 authentication, and defines routes for the application.
 * Handles user authentication, admin functionality, and server initialization.
 */
const express = require("express");
const path = require("path");
const ejsMate = require("ejs-mate");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const { auth } = require("express-openid-connect");
const pinoHttp = require("pino-http");
const logger = require("./utils/logger");
const { authLimiter, apiLimiter, healthCheckLimiter } = require("./utils/rateLimiter");
require("dotenv").config();

// Validate environment variables before starting the application
const { validateEnvironmentVariables } = require("./utils/envValidator");
validateEnvironmentVariables();

const app = express();

// Trust proxy - required for Auth0 to work correctly behind Render's proxy
// This allows Express to properly detect HTTPS via X-Forwarded-Proto header
app.set('trust proxy', 1);

// Security headers middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"], // Required for Tailwind CSS and Google Fonts
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https:"], // Required for Auth0
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"], // Required for Google Fonts
    },
  },
}));

// Rate limiting middleware - protect auth and API endpoints from abuse
app.use('/login', authLimiter);
app.use('/callback', authLimiter);
app.use('/admin-api', apiLimiter);

// HTTP request logging middleware
app.use(pinoHttp({
  logger,
  // Skip logging for static assets to reduce noise
  autoLogging: {
    ignore: (req) => req.url.startsWith('/css/') || req.url.startsWith('/js/') || req.url.startsWith('/images/'),
  },
  // Custom log level based on response status
  customLogLevel: (req, res, err) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // Custom success message
  customSuccessMessage: (req, _res) => {
    return `${req.method} ${req.url} completed`;
  },
  // Custom error message
  customErrorMessage: (req, res, err) => {
    return `${req.method} ${req.url} failed: ${err.message}`;
  },
}));

// Health check endpoint - accessible without authentication for monitoring/load balancers
// Must be placed before Auth0 middleware to bypass authentication
const { pool } = require('./db/database');
app.get('/health', healthCheckLimiter, async (req, res) => {
  try {
    // Quick database connectivity check
    await pool.query('SELECT 1');
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  } catch (_error) {
    // Database connection failed - return 503 Service Unavailable
    res.status(503).json({
      status: 'error',
      message: 'Database connection failed',
      timestamp: new Date().toISOString(),
    });
  }
});

const PORT = process.env.PORT || 3000;
const User = require("./models/User");
const Group = require("./models/Group");
const WorkHours = require("./models/WorkHours");
const WorkLocation = require("./models/WorkLocation");
const { prepareMessages } = require("./utils/messageUtils");
const { shouldShowTodayLocationSection } = require("./utils/dateStatusService");

// Auth0 configuration
const config = {
  authRequired: false,
  auth0Logout: true,
  secret: process.env.AUTH0_SECRET,
  baseURL: process.env.AUTH0_BASE_URL,
  clientID: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
  issuerBaseURL: `https://${process.env.AUTH0_DOMAIN}`,
  authorizationParams: {
    response_type: 'code',
    scope: 'openid profile email',
  },
  session: {
    rolling: true,
    rollingDuration: 86400,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
    },
  },
};

// Middleware - must be configured BEFORE Auth0 middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
// Parse signed cookies for CSRF double-submit cookie pattern
app.use(cookieParser(process.env.CSRF_COOKIE_SECRET));

// Serve static files with environment-appropriate caching
// Development: no cache for instant feedback on changes
// Production: long cache with versioned URLs for cache busting on deploy
const isDevelopment = process.env.NODE_ENV !== "production";
app.use(
  express.static(path.join(__dirname, "public"), {
    maxAge: isDevelopment ? 0 : "1y", // No cache in dev, long cache in prod
    immutable: !isDevelopment,
    etag: true,
  })
);

// auth router attaches /login, /logout, and /callback routes to the baseURL
// Must come AFTER cookie-parser to properly handle session cookies
app.use(auth(config));

// Set view engine
app.engine("ejs", ejsMate);
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

// Make asset versioning helper available to all views
const { versionedAsset } = require('./utils/assetVersion');
app.locals.versionedAsset = versionedAsset;

// Import routes
const workHoursRoutes = require("./routes/work-hours");
const holidaysRoutes = require("./routes/holidays");
const groupsRoutes = require("./routes/groups");
const publicHolidaysRoutes = require("./routes/public-holidays");
const dashboardRoutes = require("./routes/dashboard");
const adminApiRoutes = require("./routes/admin-api");
const workLocationsRoutes = require("./routes/work-locations");

// CSRF protection
const { setCsrfToken, verifyCsrf, csrfErrorHandler } = require("./utils/csrf");
// Expose token on safe methods for views
app.use(setCsrfToken);
// Verify token for all unsafe methods globally
app.use(verifyCsrf);

// Auth middleware
const requireAuth = async (req, res, next) => {
  if (!req.oidc.isAuthenticated()) {
    return res.redirect("/login");
  }

  try {
    // Get or create user in our database
    const user = await User.createFromAuth0(req.oidc.user);

    // Check if user is blocked
    if (user.is_blocked) {
      logger.warn({ email: user.email }, 'Blocked user attempted access');
      // Redirect to logout with blocked=true query param to show message after logout
      // This ensures proper cleanup of both local and Auth0 sessions
      return res.redirect("/logout?returnTo=/&blocked=true");
    }

    // Add user to the request object
    req.user = user;
    next();
  } catch (error) {
    logger.error({ err: error, path: req.originalUrl }, 'Failed to process user authentication');
    const isDevelopment = process.env.NODE_ENV !== 'production';
    return res.status(500).render("error", {
      title: "Error",
      message: "Failed to process user authentication",
      error: isDevelopment ? error : null,
      isAuthenticated: true,
      user: req.oidc.user,
    });
  }
};

// Admin role check middleware
const requireAdmin = async (req, res, next) => {
  if (!req.user || req.user.is_blocked || !req.user.isAdmin()) {
    return res.status(403).render("error", {
      title: "Dostęp zabroniony",
      message: "Ta sekcja wymaga uprawnień administratora",
      isAuthenticated: req.oidc.isAuthenticated(),
      user: req.oidc.user,
    });
  }
  next();
};

// Manager role check middleware
const requireManager = async (req, res, next) => {
  if (!req.user || req.user.is_blocked || !req.user.hasElevatedPermissions()) {
    return res.status(403).render("error", {
      title: "Dostęp zabroniony",
      message: "Ta sekcja wymaga uprawnień menedżera lub administratora",
      isAuthenticated: req.oidc.isAuthenticated(),
      user: req.oidc.user,
    });
  }
  next();
};

// Routes
app.get("/", async (req, res) => {
  let dbUser = null;
  let monthStats = null;
  let publicHolidaysOnWorkdays = [];
  let workLocationCalendars = [];
  let locationWindow = null;
  let todayLocation = null;
  let currentMonthNumber = null;
  let currentYearNumber = null;
  let todayIso = null;
  let showTodayLocationSection = true; // Default to true, will be set based on conditions
  let isTodayRestricted = false;
  let todayRestrictionReason = null;

  // If user is authenticated, get dbUser and month statistics
  if (req.oidc.isAuthenticated()) {
    try {
      // NOTE: Homepage is public (no requireAuth middleware), so we need to get user data here.
      // Performance: createFromAuth0 is throttled to only update last_login once per hour.
      dbUser = await User.createFromAuth0(req.oidc.user);

      // Fetch data for stats
      const { getWeekdaysInMonth, getMonthDateRange, formatDate } = require("./utils/dateUtils");

      // Get current month and year
      const today = new Date();
      const currentYear = today.getFullYear();
      const currentMonth = today.getMonth() + 1; // JavaScript months are 0-indexed
      currentYearNumber = currentYear;
      currentMonthNumber = currentMonth;
      todayIso = formatDate(today);
      const Holiday = require("./models/Holiday");
      const PublicHoliday = require("./models/PublicHoliday");

      // Get total work hours for the month
      const totalWorkHours = await WorkHours.getTotalMonthlyHours(
        dbUser.id,
        currentYear,
        currentMonth
      );

      // Get holiday count for the month
      const holidayCount = await Holiday.getTotalMonthlyHolidays(
        dbUser.id,
        currentYear,
        currentMonth
      );

      // Get public holidays for the month
      const publicHolidays = await PublicHoliday.findByMonthAndYear(
        currentMonth,
        currentYear
      );

      // Filter public holidays that fall on weekdays
      publicHolidaysOnWorkdays = publicHolidays.filter((holiday) => {
        const date = new Date(holiday.holiday_date);
        const dayOfWeek = date.getDay();
        return dayOfWeek !== 0 && dayOfWeek !== 6; // 0 = Sunday, 6 = Saturday
      });

      // Calculate stats
      const hoursPerDay = 8;
      const workDaysInMonth = getWeekdaysInMonth(currentYear, currentMonth);
      // Subtract all public holidays from required monthly hours
      const requiredMonthlyHours =
        (workDaysInMonth - publicHolidays.length) * hoursPerDay;

      const totalHolidayHours = holidayCount * hoursPerDay;
      const publicHolidayHours = publicHolidaysOnWorkdays.length * hoursPerDay;
      // Don't include public holidays in total combined hours
      const totalCombinedHours = totalWorkHours + totalHolidayHours;

      const remainingHours = Math.max(
        0,
        requiredMonthlyHours - totalCombinedHours
      );

      // Prepare stats object
      monthStats = {
        totalWorkHours: Math.round(totalWorkHours * 100) / 100,
        holidayCount,
        totalHolidayHours,
        publicHolidaysCount: publicHolidaysOnWorkdays.length,
        publicHolidayHours,
        totalCombinedHours: Math.round(totalCombinedHours * 100) / 100,
        requiredMonthlyHours,
        remainingHours: Math.round(remainingHours * 100) / 100,
      };

      // Prepare work location planning for previous, current and next 2 months
      const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
      const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
      const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
      const nextYear = currentMonth === 12 ? currentYear + 1 : currentYear;
      const nextMonth2 = nextMonth === 12 ? 1 : nextMonth + 1;
      const nextYear2 = nextMonth === 12 ? nextYear + 1 : nextYear;

      const { startDate: prevStart } = getMonthDateRange(
        prevYear,
        prevMonth
      );
      const { endDate: next2End } = getMonthDateRange(
        nextYear2,
        nextMonth2
      );

      const locationWindowStart = prevStart;
      const locationWindowEnd = next2End;
      locationWindow = { start: locationWindowStart, end: locationWindowEnd };

      const monthNames = [
        "",
        "Styczeń",
        "Luty",
        "Marzec",
        "Kwiecień",
        "Maj",
        "Czerwiec",
        "Lipiec",
        "Sierpień",
        "Wrzesień",
        "Październik",
        "Listopad",
        "Grudzień",
      ];

      const [locationEntries, holidayEntries, prevPublicHolidays, nextPublicHolidays, next2PublicHolidays] =
        await Promise.all([
          WorkLocation.findByUserAndDateRange(
            dbUser.id,
            locationWindowStart,
            locationWindowEnd
          ),
          Holiday.findByUserAndDateRange(
            dbUser.id,
            locationWindowStart,
            locationWindowEnd
          ),
          PublicHoliday.findByMonthAndYear(prevMonth, prevYear),
          PublicHoliday.findByMonthAndYear(nextMonth, nextYear),
          PublicHoliday.findByMonthAndYear(nextMonth2, nextYear2),
        ]);

      const allPublicHolidaysForWindow = [
        ...prevPublicHolidays,
        ...publicHolidays,
        ...nextPublicHolidays,
        ...next2PublicHolidays,
      ];

      const locationMap = {};
      locationEntries.forEach((loc) => {
        locationMap[formatDate(loc.work_date)] = loc.is_onsite;
      });

      const holidaySet = new Set(
        holidayEntries.map((h) => formatDate(h.holiday_date))
      );
      const publicHolidaySet = new Set(
        allPublicHolidaysForWindow.map((ph) => formatDate(ph.holiday_date))
      );

      const buildLocationCalendar = (month, year) => {
        const daysInMonth = new Date(year, month, 0).getDate();
        const formattedMonth = month.toString().padStart(2, "0");
        const days = [];

        for (let day = 1; day <= daysInMonth; day++) {
          const dayStr = day.toString().padStart(2, "0");
          const dateStr = `${year}-${formattedMonth}-${dayStr}`;
          const dateObj = new Date(year, month - 1, day);
          const dayOfWeek = dateObj.getDay();
          const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

          const locationValue =
            locationMap[dateStr] !== undefined ? locationMap[dateStr] : null;

          days.push({
            day,
            date: dateStr,
            isWeekend,
            isHoliday: holidaySet.has(dateStr),
            isPublicHoliday: publicHolidaySet.has(dateStr),
            is_onsite: locationValue,
            isRemote: locationValue === false,
          });
        }

        return {
          month,
          year,
          monthName: monthNames[month] || month,
          days,
        };
      };

      workLocationCalendars = [
        buildLocationCalendar(prevMonth, prevYear),
        buildLocationCalendar(currentMonth, currentYear),
        buildLocationCalendar(nextMonth, nextYear),
        buildLocationCalendar(nextMonth2, nextYear2),
      ];

      todayLocation = locationMap[formatDate(today)] ?? null;

      // Extract today's information from calendar to check restrictions
      const todayInfo = workLocationCalendars[1]?.days.find(day => day.date === todayIso);
      isTodayRestricted = todayInfo ? (todayInfo.isWeekend || todayInfo.isHoliday || todayInfo.isPublicHoliday) : false;
      todayRestrictionReason = todayInfo?.isPublicHoliday ? 'święto' : todayInfo?.isHoliday ? 'urlop' : todayInfo?.isWeekend ? 'weekend' : null;

      // Use centralized service to determine if today's location section should be shown
      showTodayLocationSection = await shouldShowTodayLocationSection(dbUser.id);
    } catch (_error) {
      // Provide fallback monthStats to prevent template crashes
      monthStats = {
        totalWorkHours: 0,
        holidayCount: 0,
        totalHolidayHours: 0,
        publicHolidaysCount: 0,
        publicHolidayHours: 0,
        totalCombinedHours: 0,
        requiredMonthlyHours: 0,
        remainingHours: 0,
      };
    }
  }

  res.render("index", {
    title: "Strona główna",
    currentPage: "home",
    isAuthenticated: req.oidc.isAuthenticated(),
    user: req.oidc.user,
    dbUser: dbUser,
    monthStats: monthStats,
    publicHolidaysOnWorkdays: publicHolidaysOnWorkdays,
    workLocationCalendars,
    todayLocation,
    locationWindow,
    currentMonthNumber: currentMonthNumber || null,
    currentYearNumber: currentYearNumber || null,
    todayIso,
    showTodayLocationSection,
    isTodayRestricted,
    todayRestrictionReason,
    messages: req.query.blocked === 'true' 
      ? { error: "Twoje konto zostało zablokowane przez administratora. Skontaktuj się z administratorem w celu uzyskania pomocy." }
      : prepareMessages(req.query),
  });
});

app.get("/profile", requireAuth, (req, res) => {
  res.render("profile", {
    title: "Profil",
    currentPage: "profile",
    isAuthenticated: req.oidc.isAuthenticated(),
    user: req.oidc.user,
    dbUser: req.user,
  });
});

// Admin dashboard route
app.get("/admin", requireAuth, requireManager, async (req, res) => {
  try {
    const users = await User.getAll();
    const groups = await Group.findAll();

    res.render("admin/index", {
      title: "Panel Administratora",
      currentPage: "admin",
      isAuthenticated: req.oidc.isAuthenticated(),
      user: req.oidc.user,
      dbUser: req.user,
      users: users,
      groups: groups,
      messages: prepareMessages(req.query),
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load admin panel');
    const isDevelopment = process.env.NODE_ENV !== 'production';
    res.status(500).render("error", {
      title: "Błąd",
      message: "Nie udało się załadować panelu administratora",
      error: isDevelopment ? error : null,
      isAuthenticated: req.oidc.isAuthenticated(),
      user: req.oidc.user,
    });
  }
});

// Admin route to update user role
app.post(
  "/admin/users/:id/role",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;
    try {
      if (!role || !["admin", "user", "manager"].includes(role)) {
        return res.status(400).send("Invalid role specified");
      }

      // Prevent admins from demoting themselves to avoid lockout scenarios
      if (parseInt(id, 10) === req.user.id && role !== "admin") {
        return res.redirect("/admin?error=cannot_demote_self");
      }

      await User.setRole(id, role);

      // Add specific message based on the new role
      let successMessage = "role_updated";
      if (role === "admin") {
        successMessage = "role_changed_to_admin";
      } else if (role === "manager") {
        successMessage = "role_changed_to_manager";
      } else if (role === "user") {
        successMessage = "role_changed_to_user";
      }

      res.redirect(`/admin?success=${successMessage}`);
    } catch (error) {
      logger.error({ err: error, userId: req.params.id, role }, 'Failed to update user role');
      const isDevelopment = process.env.NODE_ENV !== 'production';
      res.status(500).render("error", {
        title: "Błąd",
        message: "Nie udało się zaktualizować roli użytkownika",
        error: isDevelopment ? error : null,
        isAuthenticated: req.oidc.isAuthenticated(),
        user: req.oidc.user,
      });
    }
  }
);

// Register routes
app.use("/dashboard", requireAuth, requireManager, dashboardRoutes);
app.use("/work-hours", requireAuth, workHoursRoutes);
app.use("/work-locations", requireAuth, workLocationsRoutes);
app.use("/holidays", requireAuth, holidaysRoutes);
app.use("/admin/groups", requireAuth, requireAdmin, groupsRoutes);
app.use(
  "/admin/public-holidays",
  requireAuth,
  requireAdmin,
  publicHolidaysRoutes
);
app.use("/admin-api", requireAuth, requireManager, adminApiRoutes);

// CSRF error handler must be after routes
app.use(csrfErrorHandler);

// Global error handler middleware - catches all unhandled errors
app.use((err, req, res, _next) => {
  // Log error for monitoring
  logger.error({
    err,
    path: req.path,
    method: req.method,
    ip: req.ip,
  }, 'Unhandled error');

  // Determine if we should expose error details (only in development)
  const isDevelopment = process.env.NODE_ENV !== 'production';
  
  // Get HTTP status code from error or default to 500
  const statusCode = err.status || err.statusCode || 500;

  // Safely check authentication state
  const isAuthenticated = req.oidc && req.oidc.isAuthenticated();
  const user = req.oidc && req.oidc.user ? req.oidc.user : null;

  // Render error page with sanitized error data
  res.status(statusCode).render('error', {
    title: 'Błąd',
    message: 'Wystąpił błąd podczas przetwarzania żądania.',
    error: isDevelopment ? err : null, // Only expose error details in development
    isAuthenticated: isAuthenticated,
    user: user,
  });
});

// Create work-hours directory if it doesn't exist
const fs = require("fs");
const workHoursDir = path.join(__dirname, "views", "work-hours");
if (!fs.existsSync(workHoursDir)) {
  fs.mkdirSync(workHoursDir, { recursive: true });
}

// Create holidays directory if it doesn't exist
const holidaysDir = path.join(__dirname, "views", "holidays");
if (!fs.existsSync(holidaysDir)) {
  fs.mkdirSync(holidaysDir, { recursive: true });
}

// Create dashboard directory if it doesn't exist
const dashboardDir = path.join(__dirname, "views", "dashboard");
if (!fs.existsSync(dashboardDir)) {
  fs.mkdirSync(dashboardDir, { recursive: true });
}

// Initialize database schema
const initializeDb = async () => {
  try {
    const { createSchema, schemaExists } = require("./db/pg-schema");
    
    // Check if schema already exists
    const exists = await schemaExists();
    
    if (exists) {
      logger.info('PostgreSQL database schema already exists, skipping initialization');
      return;
    }
    
    // Only create schema if it doesn't exist
    logger.info('PostgreSQL database schema not found, creating...');
    await createSchema();
    logger.info('PostgreSQL database schema initialized successfully');
  } catch (error) {
    logger.error({ err: error }, 'Error initializing PostgreSQL database');
    throw error; // Fail startup if schema can't be created/verified
  }
};

// Start server
const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Server running');
  initializeDb();
});

// Graceful shutdown handling
const gracefulShutdown = async (signal) => {
  logger.info({ signal }, 'Signal received: closing HTTP server');
  
  // Stop accepting new connections
  server.close(async () => {
    logger.info('HTTP server closed');
    
    // Close database connection pool
    try {
      const { pool } = require('./db/database');
      await pool.end();
      logger.info('Database connection pool closed');
    } catch (error) {
      logger.error({ err: error }, 'Error closing database pool');
    }
    
    logger.info('Graceful shutdown completed');
    process.exit(0);
  });
  
  // Force shutdown after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

// Listen for termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught Exception');
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, _promise) => {
  logger.fatal({ reason }, 'Unhandled Rejection');
  gracefulShutdown('UNHANDLED_REJECTION');
});
