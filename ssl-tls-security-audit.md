# SSL/TLS Security Audit — LineageOS Manifest

**Date:** 2026-03-04
**Branch:** claude/check-ssl-tls-leaks-0R8sz
**Manifest Base:** `refs/tags/android-16.0.0_r4` (Android 16, SPL baseline: 2025-07-01)

---

## Summary

This audit covers the five SSL/TLS-related repositories declared in `default.xml`.
All five inherit the default AOSP remote revision (`refs/tags/android-16.0.0_r4`)
with no custom pinning or LineageOS-specific patches applied.

| Repository | Path | Remote | Pinned Revision |
|---|---|---|---|
| platform/external/boringssl | `external/boringssl` | aosp | default (`android-16.0.0_r4`) |
| platform/external/conscrypt | `external/conscrypt` | aosp | default (`android-16.0.0_r4`) |
| platform/external/mbedtls | `external/mbedtls` | aosp | default (`android-16.0.0_r4`) |
| platform/external/rust/crates/openssl | `external/rust/crates/openssl` | aosp | default (`android-16.0.0_r4`) |
| platform/prebuilts/module_sdk/conscrypt | `prebuilts/module_sdk/conscrypt` | aosp | default (`android-16.0.0_r4`) |

No hardcoded credentials, API keys, certificates, or private keys were found in
the manifest or snippets files.

---

## Findings by Component

### 1. `external/boringssl` — BoringSSL (Google fork of OpenSSL)

**Status:** No standalone formal CVEs published under the BoringSSL product name
in 2024–2025. BoringSSL uses a "live at HEAD" model and typically absorbs upstream
OpenSSL fixes without CVE assignment. BoringSSL is well-maintained by Google.

**Known Issues:**
- TLS session resumption issue: In some deployment configurations (e.g., NGINX +
  BoringSSL), the original TLS handshake's certificate verification status was not
  re-validated during session resumption. This was a server-side integration issue
  rather than a BoringSSL library bug, but is relevant for any Android components
  that implement TLS session caching.

**Risk Level:** LOW — regularly patched as part of Android security bulletins.

**Recommendation:** Ensure Android Security Bulletin patches from 2025-08-01 through
2026-03-05 are cherry-picked into the LineageOS build. These bulletins contain
security fixes that may be delivered through BoringSSL updates.

---

### 2. `external/conscrypt` — Conscrypt (Java TLS provider)

**Status:** Conscrypt is a Java Security Provider backed by BoringSSL. It delegates
all cryptographic operations to BoringSSL, so its security posture mirrors BoringSSL's.

**Known Issues:**
- Historical CVE (Android < 7.0, 2016): Information disclosure enabling MitM when
  non-standard cipher suites were used — not applicable to Android 16.
- The `android-16.0.0_r4` tag includes Conscrypt with security patch level 2025-07-01.
  Monthly Android Security Bulletins since then may contain Conscrypt-related fixes
  that have not been integrated via manifest pinning.

**Risk Level:** LOW — no known unpatched Conscrypt-specific CVEs as of 2026-03-04.

**Recommendation:** Monitor Android Security Bulletins for Conscrypt-tagged fixes.
The prebuilt `prebuilts/module_sdk/conscrypt` should be kept in sync with the
source `external/conscrypt`.

---

### 3. `external/mbedtls` — Mbed TLS (ARM lightweight TLS library)

**Status:** CRITICAL — multiple high/critical CVEs exist in Mbed TLS versions
prior to 3.6.4/3.6.5.

**Known Vulnerabilities:**

| CVE | Severity | Description | Fixed In |
|---|---|---|---|
| CVE-2024-23170 | HIGH | Timing side-channel in RSA private key operations (Marvin Attack). Remote attacker with precise timing may recover plaintext. | 3.5.2 / 2.28.7 |
| CVE-2024-45159 | MEDIUM | TLS 1.3 optional client authentication bypass. Certificate valid for other purposes accepted for client auth. | 3.6.x |
| CVE-2025-27809 | HIGH | Server impersonation risk when `mbedtls_ssl_set_hostname()` is not called. Library now blocks handshake with new error code. | 3.6.x |
| CVE-2025-27810 | MEDIUM | TLS 1.2 Finished message calculated incorrectly on memory allocation or crypto hardware failure, breaking handshake security guarantees. | 3.6.x |
| CVE-2025-49601 | MEDIUM | Out-of-bounds read in `mbedtls_lms_import_public_key()` on truncated input (< 4 bytes). Crash or limited adjacent-memory disclosure. | 3.6.4 |
| CVE-2025-49600 | HIGH | LMS signature verification bypass: unchecked return values in `mbedtls_lms_verify` allow forgery under hardware fault conditions. | 3.6.4 |
| — | HIGH | Race condition in AESNI detection: may allow AES key extraction from multithreaded programs or GCM forgery. | 3.6.4 |
| — | MEDIUM | Heap buffer under-read in PEM parsing (`mbedtls_pem_read_buffer`) via untrusted PEM input. | 3.6.4 |
| — | MEDIUM | Local timing attack on RSA/MPI operations in `mbedtls_mpi_mod_inv` and `mbedtls_mpi_gcd`. | 3.6.5 |

**Risk Level:** HIGH — multiple unfixed issues if the bundled mbedTLS version in
`android-16.0.0_r4` predates the 3.6.4/3.6.5 patch releases.

**Recommendation:**
1. Determine the exact Mbed TLS version bundled in `android-16.0.0_r4`.
2. If < 3.6.4, fork `external/mbedtls` into a LineageOS-owned repository and
   backport patches for the CVEs listed above.
3. Consider overriding the AOSP remote with a patched fork:
   ```xml
   <project path="external/mbedtls"
            name="LineageOS/android_external_mbedtls"
            groups="pdk" />
   ```

---

### 4. `external/rust/crates/openssl` — Rust `openssl` crate

**Status:** HIGH — two use-after-free vulnerabilities exist in the Rust `openssl`
crate. The underlying OpenSSL C library also has multiple 2024–2025 CVEs.

**Rust crate-specific vulnerabilities:**

| Advisory | CVE | Severity | Description | Fixed In |
|---|---|---|---|---|
| RUSTSEC-2025-0004 | CVE-2025-0977 | HIGH | Use-after-free in `ssl::select_next_proto`. Returns slice pointing into server buffer with lifetime bound to client buffer. Server may crash or return arbitrary memory to client. | 0.10.70 |
| RUSTSEC-2025-0022 | — | HIGH | Use-after-free in `Md::fetch` and `Cipher::fetch` when `properties` argument is `Some(...)`. Nearly always results in silent misuse of freed memory. | 0.10.72 |

**Underlying OpenSSL library CVEs (affecting wrapped library):**

| CVE | Severity | Description |
|---|---|---|
| CVE-2024-4741 | MEDIUM | Use-after-free via `SSL_free_buffers`. Applications calling this function may access freed memory. |
| CVE-2024-4603 | MEDIUM | DoS via excessive DSA key checking in `EVP_PKEY_param_check()` / `EVP_PKEY_public_check()`. |
| CVE-2024-5535 | HIGH | Out-of-bounds read in `SSL_select_next_proto` — up to 255 bytes of private memory sent to peer (information disclosure). |
| CVE-2025-15467 | CRITICAL | Stack buffer overflow in CMS AuthEnvelopedData parsing. Potential RCE. Affects OpenSSL 3.0–3.6 (not 1.1.1/1.0.2). |
| CVE-2025-9231 | MEDIUM | SM2 signature timing side-channel on 64-bit ARM. Private key recovery possible via precise timing. |

**Risk Level:** HIGH — use-after-free in the Rust bindings themselves (RUSTSEC-2025-0004,
RUSTSEC-2025-0022) and critical RCE in the underlying OpenSSL library (CVE-2025-15467).

**Recommendation:**
1. Verify the bundled Rust `openssl` crate version in `android-16.0.0_r4`.
2. If crate version < 0.10.72, update the crate and regenerate `Cargo.lock`.
3. Check whether AOSP's `external/rust/crates/openssl` uses OpenSSL 1.x (not
   affected by CVE-2025-15467) or OpenSSL 3.x (affected).
4. Run `cargo audit` against the Rust dependency tree to catch any additional
   advisories in transitive dependencies.

---

## Android Security Bulletin Gap Analysis

The manifest is pinned to `android-16.0.0_r4` (SPL: 2025-07-01). The following
monthly Android Security Bulletins have been released since then but are NOT
included in this pinned tag:

| Bulletin | SPL | Notable Issues |
|---|---|---|
| 2025-08-01 | 2025-08-05 | — |
| 2025-09-01 | 2025-09-05 | CVE-2024-32896 (limited targeted exploitation) |
| 2025-10-01 | 2025-10-05 | — |
| 2025-11-01 | 2025-11-05 | — |
| 2025-12-01 | 2025-12-05 | CVE-2025-48572, CVE-2025-48633 (actively exploited in the wild) |
| 2026-01-01 | 2026-01-05 | 47 CVEs including 5 Critical |
| 2026-02-01 | 2026-02-05 | CVE-2026-010 (EoP in VPU driver) |
| 2026-03-01 | 2026-03-05 | 129 CVEs; CVE-2026-21385 under active exploitation; CVE-2026-0006 (remote code execution in Media Codecs) |

**The most critical gap is the absence of patches from the December 2025 and
March 2026 bulletins, which address actively exploited vulnerabilities.**

---

## Recommendations Summary

| Priority | Action |
|---|---|
| CRITICAL | Apply Android Security Bulletin patches through 2026-03-05 (8 months of missing patches, including actively-exploited CVEs) |
| HIGH | Audit and update the Rust `openssl` crate to >= 0.10.72 (fixes RUSTSEC-2025-0004, RUSTSEC-2025-0022) |
| HIGH | Verify mbedTLS version; if < 3.6.4, fork and backport CVE-2024-23170, CVE-2025-49600, CVE-2025-49601, and the AESNI race condition fix |
| MEDIUM | Investigate CVE-2025-15467 (OpenSSL stack overflow/RCE) impact on AOSP's Rust openssl usage |
| MEDIUM | Keep `prebuilts/module_sdk/conscrypt` in sync with `external/conscrypt` source |
| LOW | Monitor BoringSSL upstream for any future CVE assignments; pin to a specific commit SHA rather than the floating tag |

---

## References

- [Android Security Bulletins](https://source.android.com/docs/security/bulletin)
- [Mbed TLS Security Advisories](https://mbed-tls.readthedocs.io/en/latest/security-advisories/)
- [RustSec Advisory Database](https://rustsec.org/advisories/)
- [RUSTSEC-2025-0004](https://rustsec.org/advisories/RUSTSEC-2025-0004.html)
- [RUSTSEC-2025-0022](https://rustsec.org/advisories/RUSTSEC-2025-0022.html)
- [CVEDetails — BoringSSL](https://www.cvedetails.com/product/47071/Google-Boringssl.html)
- [CVEDetails — Mbed TLS](https://www.cvedetails.com/product/32568/ARM-Mbed-Tls.html)
- [OpenSSL Vulnerabilities](https://openssl-library.org/news/vulnerabilities/)
- [Google Conscrypt GitHub](https://github.com/google/conscrypt)
