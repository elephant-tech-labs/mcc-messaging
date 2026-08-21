const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function formatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new Error("Enter a valid IANA timezone, such as America/Chicago.");
  }
}

function partsAt(date: Date, timeZone: string): DateTimeParts {
  const values = new Map(
    formatter(timeZone)
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.get("year") ?? 0,
    month: values.get("month") ?? 0,
    day: values.get("day") ?? 0,
    hour: values.get("hour") ?? 0,
    minute: values.get("minute") ?? 0,
  };
}

function utcNumber(parts: DateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function instantToZonedInput(
  value: string | Date | number = Date.now() + 15 * 60 * 1000,
  timeZone = browserTimeZone(),
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Choose a valid date and time.");
  const parts = partsAt(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function zonedInputToUtcIso(localValue: string, timeZone: string): string {
  const match = LOCAL_DATE_TIME.exec(localValue.trim());
  if (!match) throw new Error("Choose a valid date and time.");

  const wanted: DateTimeParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  const wantedUtc = utcNumber(wanted);
  const calendarCheck = new Date(wantedUtc);
  if (
    calendarCheck.getUTCFullYear() !== wanted.year ||
    calendarCheck.getUTCMonth() + 1 !== wanted.month ||
    calendarCheck.getUTCDate() !== wanted.day ||
    calendarCheck.getUTCHours() !== wanted.hour ||
    calendarCheck.getUTCMinutes() !== wanted.minute
  ) {
    throw new Error("Choose a valid calendar date and time.");
  }

  let candidate = wantedUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = utcNumber(partsAt(new Date(candidate), timeZone));
    const adjustment = wantedUtc - observed;
    if (adjustment === 0) break;
    candidate += adjustment;
  }

  const finalParts = partsAt(new Date(candidate), timeZone);
  if (utcNumber(finalParts) !== wantedUtc) {
    throw new Error(`That local time does not exist in ${timeZone} because of a daylight-saving change.`);
  }
  return new Date(candidate).toISOString();
}
