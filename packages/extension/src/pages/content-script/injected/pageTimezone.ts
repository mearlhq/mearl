// Temporal supplies the zone rules and Date-compatible handling of daylight-saving transitions.
interface ZonedTime {
  epochMilliseconds: number;
  offsetNanoseconds: number;
}

interface PageTemporal {
  Instant: {
    fromEpochMilliseconds(epoch: number): { toZonedDateTimeISO(zone: string): ZonedTime };
  };
  PlainDateTime: {
    from(value: string): { toZonedDateTime(zone: string): ZonedTime };
  };
}

const localGetters = {
  getFullYear: 'getUTCFullYear',
  getMonth: 'getUTCMonth',
  getDate: 'getUTCDate',
  getDay: 'getUTCDay',
  getHours: 'getUTCHours',
  getMinutes: 'getUTCMinutes',
  getSeconds: 'getUTCSeconds',
  getMilliseconds: 'getUTCMilliseconds',
} as const;

const localSetters = {
  setFullYear: 'setUTCFullYear',
  setMonth: 'setUTCMonth',
  setDate: 'setUTCDate',
  setHours: 'setUTCHours',
  setMinutes: 'setUTCMinutes',
  setSeconds: 'setUTCSeconds',
  setMilliseconds: 'setUTCMilliseconds',
} as const;

export function createPageTimezone(NativeDate: DateConstructor) {
  const temporal = (globalThis as { Temporal?: PageTemporal }).Temporal;
  const NativeDateTimeFormat = Intl.DateTimeFormat;
  const prototype = NativeDate.prototype;
  const getTime = prototype.getTime;
  const setTime = prototype.setTime;
  const toISOString = prototype.toISOString;
  const nativeParse = NativeDate.parse;
  let zone = '';
  let revision = -1;
  let zoneNames: Intl.DateTimeFormat | undefined;
  const restorers: Array<() => void> = [];

  const offsetMilliseconds = (epoch: number) =>
    temporal!.Instant.fromEpochMilliseconds(epoch).toZonedDateTimeISO(zone).offsetNanoseconds /
    1_000_000;

  const localDate = (date: Date) => {
    const epoch = getTime.call(date);
    return new NativeDate(Number.isFinite(epoch) ? epoch + offsetMilliseconds(epoch) : epoch);
  };

  const fromWallTime = (epoch: number): number => {
    if (!zone || !Number.isFinite(epoch)) return epoch;
    try {
      const wallTime = toISOString.call(new NativeDate(epoch)).slice(0, -1);
      return temporal!.PlainDateTime.from(wallTime).toZonedDateTime(zone).epochMilliseconds;
    } catch {
      return NaN;
    }
  };

  const parse = (value: unknown): number => {
    const input = `${value}`;
    // ISO date-only strings and strings with an explicit offset already describe an instant.
    if (zone && /^(?:[+-]\d{6}|\d{4})-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/i.test(input)) {
      return fromWallTime(nativeParse(`${input}Z`));
    }
    return nativeParse(input);
  };

  const withZone = (
    options?: Intl.DateTimeFormatOptions,
  ): Intl.DateTimeFormatOptions | undefined => {
    if (!zone || options === null || options?.timeZone !== undefined) return options;
    const zonedOptions = Object.create(options === undefined ? null : Object(options));
    Object.defineProperty(zonedOptions, 'timeZone', { value: zone });
    return zonedOptions;
  };

  function replace(target: object, key: string, value: (...args: never[]) => unknown): void {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
    // Pages can retain a Date method reference after the override is cleared.
    const replacement =
      target === prototype
        ? new Proxy(descriptor.value, {
            apply(original, receiver, args) {
              return Reflect.apply(zone ? value : original, receiver, args);
            },
          })
        : value;
    Object.defineProperty(target, key, { ...descriptor, value: replacement });
    restorers.push(() => {
      if (Object.getOwnPropertyDescriptor(target, key)?.value === replacement) {
        Object.defineProperty(target, key, descriptor);
      }
    });
  }

  function install(): void {
    for (const [method, utcMethod] of Object.entries(localGetters)) {
      replace(prototype, method, function (this: Date) {
        return prototype[utcMethod].call(localDate(this));
      });
    }
    for (const [method, utcMethod] of Object.entries(localSetters)) {
      replace(prototype, method, function (this: Date, ...args: number[]) {
        const local = localDate(this);
        const wallTime = Reflect.apply(prototype[utcMethod], local, args);
        return setTime.call(this, fromWallTime(wallTime));
      });
    }
    replace(prototype, 'getYear', function (this: Date) {
      return localDate(this).getUTCFullYear() - 1900;
    });
    replace(prototype, 'setYear', function (this: Date, year: number) {
      const value = Math.trunc(+year);
      if (Number.isNaN(value)) return setTime.call(this, NaN);
      return this.setFullYear(value >= 0 && value <= 99 ? value + 1900 : value);
    });
    replace(prototype, 'getTimezoneOffset', function (this: Date) {
      const epoch = getTime.call(this);
      return Number.isFinite(epoch) ? -Math.trunc(offsetMilliseconds(epoch) / 60_000) || 0 : NaN;
    });
    const toDateString = (local: Date) =>
      local
        .toUTCString()
        .slice(0, -13)
        .replace(/^(\w{3}), (\d\d) (\w{3}) (.+)$/, '$1 $3 $2 $4');
    const toTimeString = (date: Date, local: Date) => {
      const epoch = getTime.call(date);
      const minutes = Math.trunc(offsetMilliseconds(epoch) / 60_000);
      const hh = String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0');
      const mm = String(Math.abs(minutes) % 60).padStart(2, '0');
      const name = zoneNames!
        .formatToParts(epoch)
        .find(part => part.type === 'timeZoneName')?.value;
      return `${toISOString.call(local).split('T')[1].slice(0, 8)} GMT${minutes < 0 ? '-' : '+'}${hh}${mm} (${name ?? zone})`;
    };
    for (const method of ['toString', 'toDateString', 'toTimeString'] as const) {
      replace(prototype, method, function (this: Date) {
        const local = localDate(this);
        if (!Number.isFinite(getTime.call(local))) return 'Invalid Date';
        if (method === 'toDateString') return toDateString(local);
        if (method === 'toTimeString') return toTimeString(this, local);
        return `${toDateString(local)} ${toTimeString(this, local)}`;
      });
    }
    for (const method of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'] as const) {
      const native = prototype[method];
      replace(
        prototype,
        method,
        function (
          this: Date,
          locales?: Intl.LocalesArgument,
          options?: Intl.DateTimeFormatOptions,
        ) {
          return native.call(this, locales, withZone(options));
        },
      );
    }
    replace(
      Intl,
      'DateTimeFormat',
      new Proxy(NativeDateTimeFormat, {
        apply(target, receiver, [locales, options]) {
          return Reflect.apply(target, receiver, [locales, withZone(options)]);
        },
        construct(target, [locales, options], newTarget) {
          return Reflect.construct(target, [locales, withZone(options)], newTarget);
        },
      }),
    );
  }

  return {
    get active() {
      return Boolean(zone);
    },
    parse,
    fromWallTime,
    update(next: string, nextRevision: number): boolean {
      if (!Number.isSafeInteger(nextRevision) || nextRevision < 0) return false;
      if (nextRevision < revision) return true;
      if (next === zone) {
        revision = nextRevision;
        return true;
      }
      if (next && !temporal) return false;
      try {
        zoneNames = next
          ? new NativeDateTimeFormat('en-US', { timeZone: next, timeZoneName: 'long' })
          : undefined;
      } catch {
        return false;
      }
      if (next && !zone) {
        try {
          install();
        } catch {
          for (const restore of restorers.splice(0).reverse()) restore();
          return false;
        }
      }
      if (!next) {
        for (const restore of restorers.splice(0)) restore();
      }
      zone = next;
      revision = nextRevision;
      return true;
    },
  };
}
