# Territory Rx — Security Specification (Phase 0)

## 1. Data Invariants
1. **Strict Tenant Isolation**: Every document under `/users/{userId}/...` belongs exclusively to the authenticated, email-verified user where `request.auth.uid == userId`. No cross-user read, list, create, update, or delete is permitted.
2. **Identity Integrity**: Every document written to `hcps`, `clinics`, `visits`, `weeklyLocks`, `plans`, and `settings/work` must declare `userId == request.auth.uid` and `userId` is immutable on update.
3. **Path Variable Hardening**: All document IDs (`hcpId`, `clinicId`, `visitId`, `lockId`, `planId`, `settingId`) must be valid bounded identifiers (`<= 160` chars, safe charset) to prevent ID poisoning.
4. **Strict Schema & Bounds**: Every string field enforces an explicit `.size()` bound, every array field enforces a `.size()` ceiling (`windows <= 42`, `stops <= 40`, `weekendDaysIso <= 7`, `workingDaysIso <= 7`), and unknown shadow fields are rejected via `hasOnly(...)`.
5. **Android/Web Shared Backend Parity**: All 6 collections (`hcps`, `clinics`, `visits`, `weeklyLocks`, `plans`, `settings/work`) preserve 100% compatibility with both the Territory Rx Android app and Web PWA, including flexible timestamp formats (`timestamp`, `int`, `number`, or ISO `string`).
6. **Once-Per-Week Lock Atomicity**: Weekly locks are written transactionally alongside visits under `/users/{userId}/weeklyLocks/wlock_{weekStartIso}_{hcpTargetId}` and enforce `status in ['PLANNED', 'COMPLETED', 'CONFIRMED']`.
7. **Default Deny**: Any path outside the 6 explicitly declared `/users/{userId}/...` collections is denied by the top-level catch-all rule.

## 2. The "Dirty Dozen" Adversarial Payloads (Must Return PERMISSION_DENIED)
1. **Unauthenticated Read**: Unauthenticated client reading `/users/uidA/hcps/hcp_101`.
2. **Cross-Tenant Read**: Authenticated `uidB` reading `/users/uidA/hcps/hcp_101`.
3. **Cross-Tenant List**: Authenticated `uidB` listing `/users/uidA/clinics`.
4. **Identity Spoofing on Create**: `uidA` creating `/users/uidA/hcps/hcp_101` with `userId: "uidB"`.
5. **Shadow Field Injection**: `uidA` creating `/users/uidA/hcps/hcp_101` with undocumented field `isAdmin: true`.
6. **Unverified Email Write**: Authenticated user with `email_verified: false` writing `/users/uidA/settings/work`.
7. **Path ID Poisoning**: `uidA` writing `/users/uidA/hcps/<500-char-junk-id>`.
8. **String Size Exhaustion (DoW)**: `uidA` writing an HCP with a 50KB `notes` field (`> 2000` chars).
9. **Array Flood (DoW)**: `uidA` writing a Clinic with 200 `windows` entries (`> 42`).
10. **Invalid Enum Status**: `uidA` writing a Visit with `status: "HACKED"`.
11. **Immutable Owner Mutation**: `uidA` updating an existing Clinic to change `userId` to `"uidB"`.
12. **Arbitrary Settings Doc ID**: `uidA` writing `/users/uidA/settings/rogue_doc` instead of `work`.
