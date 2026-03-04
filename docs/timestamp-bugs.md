# Lineage OS Timestamp Bug Reference

Tracking document for Y2038 and GPS week-rollover bugs affecting Lineage OS
and its SDK. Intended for developers syncing the full source tree via
`repo sync`.

---

## Bug 1: Y2038 — 32-bit `time_t` Signed Integer Overflow

**Overflow date:** 2038-01-19 at 03:14:07 UTC, when a signed 32-bit integer
representing Unix seconds since 1970-01-01 wraps from 2,147,483,647 to
−2,147,483,648 (approximately 1901-12-13).

### 1.1 Bionic libc (`system/bionic`)

Tracked upstream as **Google issue b/5819737**.

In the 32-bit ABI, `time_t` is a signed 32-bit integer. This is a
deliberate, documented, unfixed ABI constraint — it cannot be silently
changed without breaking binary compatibility for existing 32-bit apps.

Key files:
- `bionic/docs/32-bit-abi.md` — official documentation of known bugs
- `bionic/libc/include/time.h` — defines `time_t`; resolves to `int32_t` on 32-bit
- `bionic/libc/include/time64.h` — workaround header providing `time64_t`
- `bionic/libc/bionic/time64.c` — implementation of 64-bit time functions

**The workaround: `<time64.h>` and its function set**

| 32-bit (vulnerable) | 64-bit Bionic equivalent (safe) |
|---|---|
| `time_t` | `time64_t` |
| `gmtime()` | `gmtime64()` |
| `gmtime_r()` | `gmtime64_r()` |
| `localtime()` | `localtime64()` |
| `localtime_r()` | `localtime64_r()` |
| `mktime()` | `mktime64()` |
| `ctime()` | `ctime64()` |
| `ctime_r()` | `ctime64_r()` |

```c
// BAD — 32-bit time_t overflows in 2038 on 32-bit targets
time_t now = time(NULL);

// GOOD — explicit 64-bit on all targets
int64_t now = (int64_t)time(NULL);

// BEST for 32-bit targets — use Bionic's time64.h
#include <time64.h>
time64_t now = mktime64(&tm_val);
```

**Related 32-bit ABI constraints that interact with Y2038:**
- `off_t` is 32-bit; use `_FILE_OFFSET_BITS=64` (available at API 24+)
- `sigset_t` is too small on ARM/x86; use `sigset64_t` / `sigaction64` (API 28+)
- `struct timespec` and `struct timeval` used in kernel syscall interfaces are
  32-bit on 32-bit processes; Linux 5.x exposes 64-bit variants but Bionic
  does not plan to wire these up — the intended path is 64-bit-only devices

### 1.2 frameworks/base (`frameworks/base`)

**`android.text.format.Time` — deprecated, Y2038-broken**

File: `frameworks/base/core/java/android/text/format/Time.java`

Internally all arithmetic uses 32-bit integers. Explicitly documented as
Y2038-unsafe. **Deprecated since API 22.**

Replacement:
- `java.time.*` (`Instant`, `ZonedDateTime`, `LocalDateTime`) for API 26+
- `java.util.GregorianCalendar` for broader API compatibility

**`SntpClient.java` — NTP Era 0 / 2036 overflow fix**

File: `frameworks/base/core/java/android/net/SntpClient.java`

NTP Era 0 ends **2036-02-07** (not 2038). Prior to fix commit `c9bbe6b`
(`Bug: 199481251`), `SntpClient` assumed era 0 always, producing wrong times
after 2036. The fix introduces `Timestamp64` and `Duration64` types with
correct era arithmetic. Check that Lineage carries this fix:

```bash
find frameworks/base -name "Timestamp64.java" -o -name "Duration64.java"
```

**`AlarmManagerService.java` — safe in Java, risky at kernel boundary**

File: `frameworks/base/services/core/java/com/android/server/AlarmManagerService.java`

Java's `long`-typed `triggerAtMillis` is 64-bit — no Y2038 overflow at the
Java layer. The risk is in the kernel path: `kernel/time/alarmtimer.c` used
`struct timespec` (Y2038-unsafe) until **Linux 5.6**, which migrated to
`struct timespec64`. Devices on kernels older than 5.6 remain affected.

**`time_detector` service — Y2038 guards (Android 12+/14+)**

Directory: `frameworks/base/services/core/java/com/android/server/timedetector/`

- **Android 12**: Lower time bound (rejects time suggestions before the
  build timestamp). `config_autoTimeDetectionLowerBound` in `config.xml`.
- **Android 14**: Upper time bound for devices with 32-bit process support,
  preventing the clock from being set to a Y2038-triggering value.

Verify these overlays are present for any Lineage device supporting 32-bit
processes.

### 1.3 Linux Kernel (`kernel/common`, `kernel/msm`, per-device trees)

Key files:
- `kernel/time/alarmtimer.c` — migrated to `timespec64` in Linux 5.6
- `fs/inode.c` and VFS inode timestamp code — migrated to `timespec64` in 2018
- XFS gained "big timestamps" in Linux 5.10 (timestamp range to year 2486)
- `ext2`, `ext4` (small inodes), and `UFS` remain constrained on 32-bit kernels

Devices on kernels older than 5.6 have Y2038-affected RTC wakeup alarms even
though the Java `AlarmManager` API is safe.

### 1.4 HAL Interfaces

**Sensor HAL — already safe**

`sensors_event_t.timestamp` uses `int64_t` nanoseconds throughout HIDL and
AIDL interfaces. No action needed.

**GNSS/GPS HAL — risky (see also Bug 2)**

Files:
```
hardware/qcom/gps/core/LocApiBase.cpp
hardware/qcom/sdm845/gps/
hardware/qcom/sm7250/gps/
hardware/qcom/sm8150/gps/
```

`GnssLocation.timestamp` carries milliseconds since Unix epoch. Any 32-bit
cast of this value is Y2038-vulnerable. The `GnssClock.full_bias_ns` field
is `int64_t` in the HIDL interface itself, but downstream HAL implementations
may truncate or cast incorrectly.

**Audio / Display HALs**

```
hardware/qcom-caf/*/audio
hardware/qcom-caf/*/display
```

Older HIDL interfaces define some timestamp struct members as `int32_t`. Any
field named `timestamp`, `timeMs`, or `timeSec` should be audited and
upgraded to `int64_t`.

---

## Bug 2: GPS Week Number Rollover

### Root cause

GPS L1 navigation messages encode the week number in a **10-bit field**
(values 0–1023, wrapping every 1,024 weeks ≈ 19.7 years). Devices that do
not apply a rollover correction compute timestamps exactly 1,024 weeks in
the past.

| Rollover | Date |
|---|---|
| 1st | 1999-08-21 |
| 2nd | 2019-04-06 |
| 3rd (next) | **2038-11-20** |

The 2019 rollover caused affected Lineage devices to report dates in 1999.
Tracked as **[LineageOS issue #1446](https://gitlab.com/LineageOS/issues/android/-/issues/1446)**.

Note: the "2042 bug" label is not a standard Android bug name. It most
likely refers to either the GPS rollover issue or the **IBM System/370 TODC
rollover on 2042-09-17** (which has no Android relevance). The next GPS
rollover at 2038-11-20 is within weeks of the Y2038 boundary, making the
two bugs potentially coincident.

### Fix

File: `hardware/qcom/gps/core/LocApiBase.cpp`
(Same pattern applies to all SoC-specific GPS HAL forks.)

```cpp
static const int64_t GPS_EPOCH_2019_MS = 1580000000000LL;  // ~2020-01-26
static const int64_t GPS_WEEK_CYCLE_MS = 1024LL * 7 * 24 * 60 * 60 * 1000;

void LocApiBase::fixGpsRollover(GpsLocation& location) {
    if (location.timestamp > 0 &&
        location.timestamp < GPS_EPOCH_2019_MS) {
        location.timestamp += GPS_WEEK_CYCLE_MS;
    }
}
```

Call `fixGpsRollover()` before passing location data to the Android location
framework via the GNSS HAL.

### GNSS HAL context

The `GnssClock` struct (`hardware/interfaces/gnss/1.0/IGnss.hal`) carries:
- `full_bias_ns` (`int64_t`) — difference between the HW GPS clock and true
  GPS time since 1980-01-06, in nanoseconds. This is where rollover errors
  propagate if the firmware does not self-correct.

In Android 12+, `gnss_time_update_service` can feed GNSS timestamps into
`time_detector`. The Android 14 upper-bound guard may reject rolled-over
values, but this is not guaranteed for all rollover magnitudes — apply the
HAL-level fix regardless.

---

## Bug 3: NTP Era Rollover (2036)

Slightly separate from Y2038: NTP Era 0 ends **2036-02-07**. Fixed in AOSP
by commit `c9bbe6b` (`Bug: 199481251`) via new `Timestamp64` / `Duration64`
types in `SntpClient.java`. Lineage should carry this fix; verify with:

```bash
find frameworks/base -name "Timestamp64.java"
```

---

## Bug 4: FAT Filesystem Timestamp Limit

FAT32 uses a 7-bit year offset from 1980, giving a maximum year of **2107**.
Timestamps are stored in local time with no UTC offset, causing ambiguity
in the `vfat` Linux driver. If a file on a FAT-formatted `/boot/efi` or
SD card partition carries a timestamp after 2038, the FAT probe can fail.

LineageOS ships `external/exfatprogs` (referenced in `lineage.xml`) and the
exFAT kernel driver. The upstream Linux exFAT driver stores UTC offsets and
removes artificial timestamp clamping — ensure Lineage tracks a recent enough
revision of `external/exfatprogs` and the exFAT kernel module.

---

## Lineage SDK Specifics (`lineage-sdk`)

The SDK is ~99% Java and 0.6% AIDL — Java's `long`-based time APIs do not
have a Y2038 problem. Key areas:

### Trust interface (`sdk/src/java/lineageos/trust/`)

`TrustInterfaceService.getSecurityPatchStatus()` uses `Calendar` and
`SimpleDateFormat("yyyy-MM-dd")` — both backed by 64-bit `long`. Safe.

```java
// Current implementation — safe past 2038
Calendar today = Calendar.getInstance();           // uses System.currentTimeMillis() — 64-bit
Calendar patchCal = Calendar.getInstance();
Date date = new SimpleDateFormat("yyyy-MM-dd").parse(patchLevel);
patchCal.setTime(date);
int diff = (today.get(Calendar.YEAR) - patchCal.get(Calendar.YEAR)) * 12 + ...
```

Risk is **low**. Audit any future JNI additions that pass timestamps across
the Java/native boundary.

### Profiles API (`lineageos/profiles/`)

Uses `AlarmManager.set()` with `long` milliseconds — safe at the Java layer.
Risk boundary is the kernel alarmtimer (see Bug 1, section 1.3).

### Backup / Seedvault (`packages/apps/Seedvault`)

File metadata passes through native `stat()`. On 32-bit kernels,
`struct stat.st_mtime` is 32-bit — a **medium risk** for archives that store
file timestamps, as restoring files after 2038 on a 32-bit kernel could
produce clamped timestamps. Prefer running Seedvault on 64-bit kernels.

---

## Risk Matrix by Repository

| Repository (manifest path) | Component | Y2038 Risk | GPS Rollover | Action |
|---|---|---|---|---|
| `system/bionic` | `time_t` 32-bit ABI | **High** (32-bit) | N/A | Use `int64_t`/`time64_t` in all Lineage native code |
| `frameworks/base` | `android.text.format.Time` | **High** if used | N/A | Replace with `java.time.*` |
| `frameworks/base` | `SntpClient.java` | **Fixed** (c9bbe6b) | N/A | Verify fix present (`Timestamp64.java`) |
| `frameworks/base` | `AlarmManagerService.java` | Low (Java); Med (kernel) | N/A | Ensure Linux 5.6+ kernel |
| `frameworks/base` | `time_detector` | Mitigated (Android 14) | N/A | Confirm `config.xml` upper-bound overlay |
| `lineage-sdk` | Trust / Profiles | Low | N/A | Audit JNI boundaries |
| `lineage-sdk` / Seedvault | Backup metadata | Medium | N/A | Prefer 64-bit kernel for backups |
| `hardware/qcom/gps` (all SoC variants) | `LocApiBase.cpp` | Medium | **High** | Apply GPS rollover correction; use `int64_t` |
| `hardware/qcom-caf/*/audio` | HIDL timestamp structs | Medium | N/A | Audit `int32_t` fields → `int64_t` |
| `hardware/qcom-caf/*/display` | HIDL timestamp structs | Medium | N/A | Same as audio |
| `kernel/time/alarmtimer.c` | `ALARM_REALTIME` timers | Medium (pre-5.6) | N/A | Backport `timespec64` or upgrade to Linux 5.6+ |
| `external/exfatprogs` / exFAT driver | FAT timestamps | Low | N/A | Track upstream Linux exFAT driver |

---

## Diagnostic Commands (run after `repo sync`)

```bash
# 1. Scan for 32-bit time_t in Lineage native code
grep -r "time_t " lineage-sdk/lib/ lineage-sdk/lineage/ \
  packages/apps/LineageParts/ packages/apps/Profiles/ \
  --include="*.c" --include="*.cpp" --include="*.h"

# 2. Scan for deprecated android.text.format.Time usage
grep -r "android\.text\.format\.Time" lineage-sdk/ packages/ \
  --include="*.java"

# 3. Verify GPS rollover fix in QCOM GPS HALs
grep -r "GPS_WEEK\|rollover\|619315200\|1580000000" \
  hardware/qcom/gps/ hardware/qcom/sdm845/gps/ \
  hardware/qcom/sm7250/gps/ hardware/qcom/sm8150/gps/ \
  --include="*.cpp" --include="*.c"

# 4. Verify SntpClient NTP era fix
find frameworks/base -name "Timestamp64.java" -o -name "Duration64.java"

# 5. Find 32-bit int timestamp fields in HIDL/AIDL interfaces
grep -r "int32_t.*[Tt]ime\|int32_t.*[Tt]s\b" \
  hardware/interfaces/ hardware/qcom-caf/ \
  --include="*.hal" --include="*.aidl"
```

---

## References

- [Android Bionic 32-bit ABI bugs](https://github.com/aosp-mirror/platform_bionic/blob/main/docs/32-bit-abi.md)
- [Android Time Overview (AOSP Docs)](https://source.android.com/docs/core/connect/time)
- [SntpClient NTP 2036 era fix commit c9bbe6b](https://android.googlesource.com/platform/frameworks/base.git/+/c9bbe6b59e9d48e690fbbd86734de4af3b94413b)
- [android.text.format.Time API reference](https://developer.android.com/reference/android/text/format/Time)
- [LineageOS GPS rollover issue #1446](https://gitlab.com/LineageOS/issues/android/-/issues/1446)
- [How to detect GPS week rollover on Android — Sean Barbeau](https://barbeau.medium.com/how-to-detect-gps-week-rollover-problems-on-android-5cc739f2fa9c)
- [Solving the Y2038 problem in the Linux kernel — Opensource.com](https://opensource.com/article/19/1/year2038-problem-linux-kernel)
- [Linux 5.10 XFS big timestamps — The Register](https://www.theregister.com/2020/10/19/linux_5_10_y2k38_fixes/)
- [Time formatting and storage bugs — Wikipedia](https://en.wikipedia.org/wiki/Time_formatting_and_storage_bugs)
- [Year 2038 problem — Wikipedia](https://en.wikipedia.org/wiki/Year_2038_problem)
