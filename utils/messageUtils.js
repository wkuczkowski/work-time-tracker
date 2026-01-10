/**
 * Message utility functions for the Work Time Tracker application.
 * Handles application-wide notification and messaging system.
 * Maps short message codes to their full text versions in Polish.
 * Processes and prepares messages for display in the UI.
 */

// Message type mappings
const messageMap = {
  success: {
    // Holiday-related messages
    holiday_added: "Pomyślnie dodano urlop.",
    holiday_deleted: "Pomyślnie usunięto urlop.",

    // Work hours-related messages
    work_added: "Pomyślnie dodano wpis czasu pracy.",
    work_deleted: "Pomyślnie usunięto wpis czasu pracy.",
    work_updated: "Pomyślnie zaktualizowano wpis czasu pracy.",

    // Admin-related messages
    role_updated: "Rola użytkownika została zaktualizowana pomyślnie.",
    users_synced: "Użytkownicy zostali zsynchronizowani z Auth0 pomyślnie.",
    user_blocked: "Status użytkownika został zaktualizowany pomyślnie.",
    role_changed_to_manager: "Rola użytkownika została zmieniona na Menedżera.",
    role_changed_to_admin:
      "Rola użytkownika została zmieniona na Administratora.",
    role_changed_to_user: "Rola użytkownika została zmieniona na Użytkownika.",

    // Group-related messages
    group_created: "Grupa została utworzona pomyślnie.",
    group_updated: "Nazwa grupy została zaktualizowana pomyślnie.",
    group_deleted: "Grupa została usunięta pomyślnie.",
    user_assigned: "Użytkownik został przypisany do grupy pomyślnie.",

    // Generic messages
    added: "Pomyślnie dodano wpis.",
    deleted: "Pomyślnie usunięto wpis.",
    updated: "Pomyślnie zaktualizowano dane.",
    imported: "Pomyślnie zaimportowano dane.",
  },
  error: {
    // Generic errors
    failed: "Wystąpił błąd. Spróbuj ponownie.",
    not_found: "Nie znaleziono wpisu.",
    unauthorized: "Brak uprawnień do wykonania tej operacji.",
    admin_only: "Ta operacja wymaga uprawnień administratora.",

    // Group-related errors
    group_has_users: "Nie można usunąć grupy, która ma przypisanych użytkowników.",

    // Admin-related errors
    cannot_demote_self: "Nie możesz zmienić swojej własnej roli. Poproś innego administratora o dokonanie tej zmiany.",

    // Holiday-specific errors
    invalid_date: "Proszę wybrać prawidłową datę.",
    work_hours_conflict:
      "Nie można dodać urlopu dla dnia, w którym masz już wpisane godziny pracy.",
    holiday_not_found: "Nie znaleziono urlopu.",
    weekend_not_allowed: "Nie można ustawić urlopu w weekend.",
    public_holiday_not_allowed: "Nie można ustawić urlopu w dzień ustawowo wolny.",
    weekend_only: "Wybrany zakres zawiera tylko weekendy.",
    no_valid_days: "Wybrany zakres nie zawiera żadnych dni roboczych (wykluczono weekendy i dni ustawowo wolne).",

    // Work hours-specific errors
    holiday: "Nie można dodać wpisu w dzień urlopowy.",
    invalid_hours: "Podaj prawidłową liczbę godzin (większą niż 0).",
    cannot_update_old: "Możesz edytować wpisy tylko z dzisiaj lub wczoraj.",
    cannot_delete_old: "Możesz usuwać wpisy tylko z dzisiaj lub wczoraj.",
    work_invalid_date:
      "Możesz dodawać wpisy tylko dla dzisiaj, wczoraj lub przedwczoraj.",
  },
  info: {
    no_changes: "Nie wprowadzono żadnych zmian.",
  },
  warning: {
    pending: "Operacja oczekuje na zatwierdzenie.",
  },
};

/**
 * Prepares messages for the notification system
 * @param {Object} messages - Message object (e.g., req.query)
 * @returns {Object} Processed message object with full text
 */
const prepareMessages = (messages) => {
  const result = {};

  if (!messages) return result;

  // Process success messages
  if (messages.success) {
    // Check for added_X_days format (for multi-day holiday additions)
    if (
      messages.success.startsWith("added_") &&
      messages.success.includes("_days")
    ) {
      let messageText = "";
      
      if (messages.success.includes("_weekends_and_holidays_excluded")) {
        const daysCount = messages.success
          .replace("added_", "")
          .replace("_days_weekends_and_holidays_excluded", "");
        messageText = `Pomyślnie dodano ${daysCount} dni urlopowych. Pominięto weekendy i dni ustawowo wolne.`;
      } else if (messages.success.includes("_holidays_excluded")) {
        const daysCount = messages.success
          .replace("added_", "")
          .replace("_days_holidays_excluded", "");
        messageText = `Pomyślnie dodano ${daysCount} dni urlopowych. Pominięto dni ustawowo wolne.`;
      } else if (messages.success.includes("_weekends_excluded")) {
        const daysCount = messages.success
          .replace("added_", "")
          .replace("_days_weekends_excluded", "");
        messageText = `Pomyślnie dodano ${daysCount} dni urlopowych. Pominięto weekendy.`;
      } else {
        const daysCount = messages.success
          .replace("added_", "")
          .replace("_days", "");
        messageText = `Pomyślnie dodano ${daysCount} dni urlopowych.`;
      }
      result.success = messageText;
    } else if (messages.success === "added_weekends_and_holidays_excluded") {
      result.success = "Pomyślnie dodano urlop. Pominięto weekendy i dni ustawowo wolne.";
    } else if (messages.success === "added_holidays_excluded") {
      result.success = "Pomyślnie dodano urlop. Pominięto dni ustawowo wolne.";
    } else if (messages.success === "added_weekends_excluded") {
      result.success = "Pomyślnie dodano urlop. Pominięto weekendy.";
    } else {
      result.success = messageMap.success[messages.success] || messages.success;
    }
  }

  // Process error messages
  if (messages.error) {
    result.error = messageMap.error[messages.error] || messages.error;
  }

  // Process info messages
  if (messages.info) {
    result.info = messageMap.info[messages.info] || messages.info;
  }

  // Process warning messages
  if (messages.warning) {
    result.warning = messageMap.warning[messages.warning] || messages.warning;
  }

  return result;
};

module.exports = {
  prepareMessages,
  messageMap,
};
