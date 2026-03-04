# Timestamp and Year Bugs in Lineage OS

This document is a reference guide for Lineage OS developers covering known
timestamp-related bugs, their affected components, and recommended fixes.

---

## Table of Contents

1. [Y2038 Problem](#y2038-problem)
2. [GPS Week Number Rollover](#gps-week-number-rollover)
3. [NTP Era Rollover (2036)](#ntp-era-rollover-2036)
4. [FAT Filesystem Timestamp Limits](#fat-filesystem-timestamp-limits)
5. [Risk Matrix](#risk-matrix)
6. [Diagnostic Commands](#diagnostic-commands)
7. [References](#references)

---

## Y2038 Problem

### Overview

The Y2038 problem (also called the "Epochalypse") occurs when a signed 32-bit
`time_t` value overflows.  The maximum value of a signed 32-bit integer is
`2147483647`, which corresponds to **2038-01-19 03:14:07 UTC**.  After that
instant, a naïve 32-bit `time_t` wraps to a large negative number and is
interpreted as a date in 1901.

### Bionic libc

Android's C library (Bionic) historically used a 32-bit `time_t` on 32-bit
architectures.  Since Android 12 (API level 32) Bionic has moved all
architectures to a 64-bit `time_t`, but **32-bit processes running on a 64-bit
kernel** can still encounter this issue if:

- They are compiled against an older NDK that defines `time_t` as `int32_t`.
- They use out-of-tree HAL libraries built with a 32-bit toolchain.

**Workaround for legacy code** — use the `time64.h` shim provided by Bionic:

```c
#include <time64.h>

time64_t now = time64(NULL);   /* always 64-bit */
struct tm result;
localtime64_r(&now, &result);
```

### Android Framework

`android.text.format.Time` was deprecated in API level 22 because it wraps the
32-bit C `mktime()` and is therefore Y2038-unsafe.  Use
`java.util.Calendar` or `java.time.*` (API 26+) instead:

```java
// Deprecated — do NOT use in new code
android.text.format.Time t = new android.text.format.Time();

// Preferred
import java.time.Instant;
Instant now = Instant.now();   // backed by long (64-bit milliseconds)
```

### NTP / SntpClient

`frameworks/base/core/java/android/net/SntpClient.java` converts NTP
timestamps (seconds since 1900-01-01) to Unix time (seconds since 1970-01-01)
using a 32-bit offset.  NTP Era 0 ends on **2036-02-07 06:28:16 UTC**, after
which the raw 32-bit NTP second counter wraps to zero (Era 1 begins).

Versions of `SntpClient` that do not handle era wraparound will compute wall
clock times ~136 years in the past.  The AOSP fix (commit `c9bbe6b`) introduces
`Timestamp64`/`Duration64` helper types; see the
[NTP Era Rollover](#ntp-era-rollover-2036) section for details.

### Kernel: alarmtimer and Filesystem Timestamps

The Linux kernel's `alarmtimer` driver (`kernel/time/alarmtimer.c`) stores
alarm expiry times as `ktime_t` (64-bit nanoseconds), so it is Y2038-safe on
its own.  However, user-space code that converts between `ktime_t` and a 32-bit
`time_t` before passing values to `timerfd_settime()` or `alarm_set()` will
silently truncate the time.

Filesystem limits (see also [FAT Filesystem Timestamp Limits](#fat-filesystem-timestamp-limits)):

| Filesystem | Max timestamp       | Notes                          |
|------------|---------------------|--------------------------------|
| ext4       | 2446-05-10          | 34-bit seconds + ns field      |
| F2FS       | 2446-05-10          | same as ext4                   |
| FAT32      | 2107-12-31          | 7-bit year field (1980 base)   |
| exFAT      | 2107-12-31          | same as FAT32                  |

### HAL Interfaces

Several HAL interfaces pass timestamps as `int32_t` or `uint32_t` fields and
must be audited:

| HAL / File                            | Field             | Risk                         |
|---------------------------------------|-------------------|------------------------------|
| `hardware/interfaces/gnss/`           | `GnssLocation.timestamp` | Overflow in 2038 if 32-bit |
| `hardware/interfaces/audio/`          | presentation timestamps  | 32-bit frame counters      |
| `hardware/interfaces/graphics/`       | `presentFence` timestamps | driver-dependent          |

**Recommended fix**: replace `int32_t` / `uint32_t` timestamp fields with
`int64_t` and update all callers.

---

## GPS Week Number Rollover

### Overview

GPS time is broadcast by satellites as a **10-bit Week Number** (WN) plus
**Time of Week** (TOW, seconds).  Because the field is only 10 bits wide, it
can represent only 1024 weeks (~19.7 years) before wrapping back to zero.

### Historic and Future Rollover Dates

| Rollover | Date (UTC)    | Notes                                       |
|----------|---------------|---------------------------------------------|
| 0 → 1    | 1999-08-21    | GPS epoch began 1980-01-06                  |
| 1 → 2    | 2019-04-06    | Affected some older receiver firmware       |
| 2 → 3    | **2038-11-20** | Coincides with the Y2038 window            |

### Impact on Lineage Devices

Devices that compute absolute UTC time from GPS week + TOW without accounting
for past rollovers will report incorrect dates.  This affects:

- Navigation apps using raw GNSS measurements.
- Location timestamps stored in EXIF metadata.
- Any code path that stores GPS-derived time as a 32-bit Unix timestamp.

### HAL-level Fix: `LocApiBase.cpp`

A common pattern in vendor GNSS HAL code is:

```cpp
// VULNERABLE — does not handle week rollover
int32_t gps_utc_time = (week_number * WEEK_MSECS) + time_of_week_ms
                       - GPS_UTC_OFFSET_MS;
location.timestamp = gps_utc_time;
```

The fix requires:

1. Casting to `int64_t` before multiplication to prevent overflow.
2. Adding the number of elapsed rollovers × `1024 × WEEK_MSECS`.

```cpp
// SAFE — handles rollover and uses 64-bit arithmetic
static constexpr int64_t WEEK_MSECS_64 = 7LL * 24 * 60 * 60 * 1000;
static constexpr int64_t GPS_EPOCH_MS  = 315964800000LL; // 1980-01-06 in ms
static constexpr int64_t ROLLOVER_MS   = 1024LL * WEEK_MSECS_64;

int64_t compute_gps_utc_ms(uint16_t week, uint32_t tow_ms) {
    // Extend 10-bit week to full week count using current system time
    int64_t now_ms = static_cast<int64_t>(time(nullptr)) * 1000LL;
    int64_t approx_gps_ms = GPS_EPOCH_MS
                            + static_cast<int64_t>(week) * WEEK_MSECS_64
                            + tow_ms;

    // Add rollovers until the result is close to wall-clock time
    while (approx_gps_ms + ROLLOVER_MS / 2 < now_ms) {
        approx_gps_ms += ROLLOVER_MS;
    }

    return approx_gps_ms;
}
```

---

## NTP Era Rollover (2036)

### Background

NTP timestamps are 64-bit values: a 32-bit unsigned seconds field (Era) and a
32-bit fractional seconds field.  Era 0 counts seconds from **1900-01-01
00:00:00 UTC**; it overflows (wraps to zero, beginning Era 1) on
**2036-02-07 06:28:16 UTC**.

### Affected File

`frameworks/base/core/java/android/net/SntpClient.java`

Legacy code computes Unix time from an NTP timestamp with a fixed 70-year
offset (`OFFSET_1900_TO_1970 = 2208988800L`) cast to `int` in some code
paths, which overflows before subtracting the offset.

### AOSP Fix (commit `c9bbe6b`)

The upstream fix introduces two helper classes in the same package:

```java
// Timestamp64: wraps a 64-bit NTP timestamp value
// Duration64:  represents a signed duration for era-aware arithmetic
```

Key change in `SntpClient.java`:

```java
// Before (era-unaware)
long clockOffset = ((int)(t1 - t0) + (int)(t3 - t2)) / 2;

// After (era-aware, using Timestamp64 arithmetic)
Duration64 offset = Timestamp64.between(clientReceive, serverTransmit)
                               .plus(Timestamp64.between(serverReceive, clientTransmit))
                               .dividedBy(2);
long wallClockMs = offset.toMillis() + System.currentTimeMillis();
```

Lineage trees that have not yet cherry-picked this commit should do so from the
appropriate AOSP branch.

---

## FAT Filesystem Timestamp Limits

### FAT32

The FAT32 directory entry stores the modification year as a **7-bit field**
with a base year of 1980, giving a maximum representable year of
`1980 + 127 = 2107`.  Writes after 2107-12-31 will silently wrap (most
implementations clamp to 2107 or store year 0 = 1980).

Kernel driver: `fs/fat/dir.c` — the `fat_time_unix2fat()` function clamps the
year to the 1980–2107 range.

### exFAT

exFAT uses the same 7-bit year encoding and has the same 2107 limit.  The
kernel exFAT driver (`fs/exfat/`) inherits this constraint.

### Recommendations

- For external storage formatted as FAT32/exFAT, document the 2107 limit to
  end-users; it is a format constraint and cannot be fixed in the driver.
- Avoid using `mtime` from FAT-mounted paths as an authoritative timestamp in
  system code; use a separate metadata file with a wider timestamp if needed.
- Consider recommending exFAT or ext4 for new devices where the storage
  controller supports it.

---

## Risk Matrix

| Component / Repository              | Bug              | Severity | Status        |
|-------------------------------------|------------------|----------|---------------|
| Bionic libc (32-bit builds)         | Y2038            | High     | Fixed in A12+ |
| `android.text.format.Time`          | Y2038            | Medium   | Deprecated    |
| `SntpClient.java`                   | NTP Era 2036     | High     | Fix in AOSP   |
| `kernel/time/alarmtimer.c`          | Y2038 (indirect) | Low      | Kernel 64-bit |
| FAT32 / exFAT driver                | FAT 2107         | Low      | By design     |
| GNSS HAL (`LocApiBase.cpp`)         | GPS rollover     | High     | Vendor-specific|
| Audio HAL presentation timestamps   | Y2038            | Medium   | Audit needed  |
| Graphics HAL fence timestamps       | Y2038            | Medium   | Audit needed  |

---

## Diagnostic Commands

Use these commands after running `repo sync` to locate potentially vulnerable
patterns in the source tree.

### Find 32-bit `time_t` usages

```bash
grep -rn '\btime_t\b' \
  --include='*.c' --include='*.cpp' --include='*.h' \
  --exclude-dir='.git' \
  bionic/ hardware/ frameworks/ \
  | grep -v 'time64_t\|int64_t'
```

### Find deprecated `android.text.format.Time`

```bash
grep -rn 'android\.text\.format\.Time' \
  --include='*.java' --include='*.kt' \
  frameworks/ packages/
```

### Find NTP era-unaware offset arithmetic

```bash
grep -rn 'OFFSET_1900_TO_1970\|2208988800' \
  --include='*.java' \
  frameworks/base/
```

### Find 10-bit GPS week usage without rollover handling

```bash
grep -rn 'week_number\|weekNumber\|gpsWeek\|GPS_WEEK' \
  --include='*.c' --include='*.cpp' \
  hardware/
```

### Find FAT year encoding

```bash
grep -rn 'fat_time_unix2fat\|FAT_DATE\|fat_date' \
  --include='*.c' \
  kernel/
```

---

## References

- [Y2038 on Wikipedia](https://en.wikipedia.org/wiki/Year_2038_problem)
- [Bionic time64 header](https://android.googlesource.com/platform/bionic/+/refs/heads/main/libc/include/time64.h)
- [AOSP SntpClient.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/net/SntpClient.java)
- [AOSP commit c9bbe6b — NTP era fix](https://android.googlesource.com/platform/frameworks/base/+/c9bbe6b)
- [GPS Interface Control Document IS-GPS-200](https://www.gps.gov/technical/icwg/)
- [GPS Week Rollover — US DHS advisory](https://www.cisa.gov/gps-week-number-rollover)
- [Linux kernel FAT driver — `fs/fat/dir.c`](https://elixir.bootlin.com/linux/latest/source/fs/fat/dir.c)
- [Android API deprecation — `android.text.format.Time`](https://developer.android.com/reference/android/text/format/Time)
- [LineageOS Wiki](https://wiki.lineageos.org/)
