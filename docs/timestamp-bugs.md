# Lineage OS Timestamp Bug Reference

Tracking document for Y2038 and GPS week-rollover (mislabelled "2042") bugs
affecting Lineage OS and its SDK. Intended for developers syncing the full
source tree via `repo sync`.

---

## 1. Y2038 — 32-bit `time_t` Overflow

### Root cause

On 32-bit ABIs, `time_t` is a signed 32-bit integer. It overflows on
**2038-01-19 03:14:07 UTC**, wrapping to -2147483648 (≈ 1901-12-13).

64-bit ABIs are not affected: `time_t` is 64-bit there. Lineage OS 23.x
(Android 14 base) inherits AOSP's partial mitigations, but 32-bit processes
and legacy HALs remain at risk.

### AOSP mitigations already present (Lineage inherits)

| Android version | Mitigation |
|---|---|
| Android 9 | 64-bit userspace uses 64-bit `time_t` by default |
| Android 12 | `time_detector` service adds a **lower** time bound (rejects times before build timestamp) |
| Android 14 | `time_detector` adds an **upper** time bound for devices that support 32-bit processes |

### Remaining gaps — what still needs fixing

#### Bionic libc (`system/bionic`)

File: `bionic/docs/32-bit-abi.md` (tracked upstream as **b/5819737**)

- `time_t` is 32-bit in the 32-bit ABI — this is a documented, unfixed ABI
  constraint. It cannot be silently changed without breaking binary
  compatibility for existing 32-bit apps.
- `off_t` is also 32-bit; stdio still uses 32-bit offsets internally.
- `sigset_t` is too small on ARM/x86 (breaks real-time signals).

**Recommended action:** Ensure all Lineage-specific native code that handles
time uses `int64_t` / `time64_t` explicitly rather than `time_t` when
compiled for 32-bit targets.

```c
// BAD — 32-bit time_t overflows in 2038
time_t now = time(NULL);

// GOOD — explicit 64-bit, safe past 2038
#include <time.h>
int64_t now = (int64_t)time(NULL);  // or use clock_gettime with timespec64
```

#### frameworks/base (`platform/frameworks/base`)

Files of concern:

- `core/java/android/text/format/Time.java` — legacy time class backed by
  native 32-bit `time_t`. Deprecated in API 22. Any Lineage code still using
  `android.text.format.Time` must migrate to `java.time.Instant` or
  `java.util.Calendar`.
- `core/java/android/net/SntpClient.java` — NTP client; uses `long`
  (64-bit ms) internally, safe.
- `services/core/java/com/android/server/AlarmManagerService.java` —
  schedules alarms using `long` milliseconds (64-bit). Safe in Java. Risk
  exists in the underlying native/kernel RTC path for 32-bit kernels.

**Java rule:** `java.util.Date` and `System.currentTimeMillis()` use 64-bit
`long` milliseconds and do not have a Y2038 problem in Java. The risk is in
JNI boundaries where `long` is truncated to `int` or `time_t` in C code.

#### Lineage SDK (`lineage-sdk` / `android_lineage-sdk`)

The SDK is ~99% Java. Safe areas and risk areas:

| Component | Risk | Notes |
|---|---|---|
| Trust interface | Low | Java-side; uses `long` timestamps |
| Privacy Guard | Low | Permission timestamps use `long` |
| Profiles | Low | Schedule times use `AlarmManager` (64-bit `long`) |
| Backup / Restore | Medium | File timestamps may pass through native `stat()` with 32-bit `st_mtime` on 32-bit kernels |
| Updater app | Low | Download/build timestamps are string-parsed, not native `time_t` |

**Action for Lineage SDK:** Audit any JNI calls that pass timestamps across
the Java/native boundary. Ensure the native side uses `int64_t`, not
`time_t` or `int`.

#### HAL interfaces (`hardware/qcom/gps`, `hardware/qcom/audio`, etc.)

HIDL/AIDL interfaces that carry `int32_t` timestamps must be updated to
`int64_t`. Specific known-risky file:

```
hardware/qcom/gps/core/LocApiBase.cpp
```

This file is also the site of the GPS rollover fix (see Section 2).

---

## 2. GPS Week Number Rollover ("2042 bug")

### Root cause

GPS L1 navigation messages encode the week number in a **10-bit field**.
This wraps every **1 024 weeks ≈ 19.7 years**. Devices that do not apply a
rollover correction compute timestamps that are 1 024 weeks (~19.7 years) in
the past.

The most recent rollover was **2019-04-06**. Unpatched devices reported the
year as 1999. This is tracked in Lineage OS as
**[LineageOS issue #1446](https://gitlab.com/LineageOS/issues/android/-/issues/1446)**.

The *next* GPS rollover is **~2038-11-20** — close enough to the Y2038
boundary that it could be confused with that bug.

The "2042" label may refer to the **IBM System/370 TODC rollover on
2042-09-17**, which is unrelated to Android but is a real date-overflow event
in legacy computing literature.

### Fix

File: `hardware/qcom/gps/core/LocApiBase.cpp`

Apply the following correction when the timestamp is below the expected
post-2019-rollover threshold:

```cpp
// GPS week rollover correction
// If GPS reports a timestamp from before the 2019 rollover epoch,
// add 1024 weeks (one full GPS epoch cycle).
static const int64_t GPS_EPOCH_2019_MS = 1580000000000LL;  // ~2020-01-26
static const int64_t GPS_WEEK_CYCLE_MS = 1024LL * 7 * 24 * 60 * 60 * 1000;

void LocApiBase::fixGpsRollover(GpsLocation& location) {
    if (location.timestamp > 0 &&
        location.timestamp < GPS_EPOCH_2019_MS) {
        location.timestamp += GPS_WEEK_CYCLE_MS;
    }
}
```

This fix should be applied before passing location data to the Android
location framework.

---

## 3. Summary of Required Changes by Repository

| Repository | Path in manifest | Change needed |
|---|---|---|
| `platform/bionic` | `system/bionic` | Document 32-bit `time_t` constraint; ensure Lineage additions use `int64_t` |
| `platform/frameworks/base` | `frameworks/base` | Remove uses of deprecated `android.text.format.Time`; audit JNI timestamp boundaries |
| `android_lineage-sdk` | `lineage-sdk` | Audit JNI boundaries; ensure backup/restore uses 64-bit timestamps |
| `android_hardware_qcom_audio` | `hardware/qcom-caf/*/audio` | Audit HIDL struct timestamp fields for `int32_t` → `int64_t` |
| `android_hardware_qcom_display` | `hardware/qcom-caf/*/display` | Same as audio |
| Various GPS HALs | `hardware/qcom/gps`, `hardware/qcom/sdm845/gps`, etc. | Apply GPS week rollover correction in `LocApiBase.cpp` |

---

## 4. Testing recommendations

Once source is synced (`repo sync`), validate fixes with:

```bash
# Check for 32-bit time_t uses in Lineage-specific native code
grep -r "time_t " lineage-sdk/lib/ lineage-sdk/lineage/ \
  packages/apps/LineageParts/ packages/apps/Profiles/ \
  --include="*.c" --include="*.cpp" --include="*.h"

# Check for deprecated Time class usage
grep -r "android.text.format.Time" lineage-sdk/ packages/ \
  --include="*.java"

# Check GPS HAL rollover fix presence
grep -r "GPS_WEEK" hardware/qcom/gps/ \
  --include="*.cpp" --include="*.c"
```

Devices to prioritise for 32-bit validation:
- Any device shipping a **32-bit kernel** (ARMv7, older Snapdragon 400/600 series)
- Any device using a **Qualcomm GPS HAL** not yet updated past the 2019 rollover

---

## References

- [Android Bionic 32-bit ABI bugs](https://github.com/aosp-mirror/platform_bionic/blob/main/docs/32-bit-abi.md)
- [Android time overview (AOSP docs)](https://source.android.com/docs/core/connect/time)
- [LineageOS GPS rollover issue #1446](https://gitlab.com/LineageOS/issues/android/-/issues/1446)
- [How to detect GPS week rollover on Android — Sean Barbeau](https://barbeau.medium.com/how-to-detect-gps-week-rollover-problems-on-android-5cc739f2fa9c)
- [Wikipedia: Year 2038 problem](https://en.wikipedia.org/wiki/Year_2038_problem)
- [Wikipedia: Time formatting and storage bugs](https://en.wikipedia.org/wiki/Time_formatting_and_storage_bugs)
