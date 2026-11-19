/**
 * Territory Rx — Phase 0 Security Rules Test Specification (Dirty Dozen)
 * Run with Firebase Emulator Suite (`@firebase/rules-unit-testing`) when validating locally.
 */
export interface DirtyDozenCase {
  id: number;
  name: string;
  actorUid: string | null;
  emailVerified: boolean;
  operation: 'get' | 'list' | 'create' | 'update';
  path: string;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const dirtyDozenCases: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Unauthenticated read of HCP record',
    actorUid: null,
    emailVerified: false,
    operation: 'get',
    path: 'users/uidA/hcps/hcp_101',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Cross-tenant read of another rep HCP',
    actorUid: 'uidB',
    emailVerified: true,
    operation: 'get',
    path: 'users/uidA/hcps/hcp_101',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Cross-tenant list of another rep clinics',
    actorUid: 'uidB',
    emailVerified: true,
    operation: 'list',
    path: 'users/uidA/clinics',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Identity spoofing userId on HCP create',
    actorUid: 'uidA',
    emailVerified: true,
    operation: 'create',
    path: 'users/uidA/hcps/hcp_101',
    payload: { userId: 'uidB', targetId: '101', name: 'Dr. Spoof' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Shadow field injection on HCP create',
    actorUid: 'uidA',
    emailVerified: true,
    operation: 'create',
    path: 'users/uidA/hcps/hcp_101',
    payload: { userId: 'uidA', targetId: '101', name: 'Dr. Ghost', isAdmin: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Unverified email writing work settings',
    actorUid: 'uidA',
    emailVerified: false,
    operation: 'create',
    path: 'users/uidA/settings/work',
    payload: { userId: 'uidA', dailyHcpTarget: 8 },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Path ID poisoning with oversized doc ID',
    actorUid: 'uidA',
    emailVerified: true,
    operation: 'create',
    path: `users/uidA/hcps/${'a'.repeat(300)}`,
    payload: { userId: 'uidA', targetId: '101', name: 'Dr. LongId' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'String size exhaustion (50KB notes)',
    actorUid: 'uidA',
    emailVerified: true,
    operation: 'create',
    path: 'users/uidA/hcps/hcp_102',
    payload: { userId: 'uidA', targetId: '102', name: 'Dr. Heavy', notes: 'x'.repeat(50000) },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Array flood on clinic windows (> 42)',
    actorUid: 'uidA',
    emailVerified: true,
    operation: 'create',
    path: 'users/uidA/clinics/clinic_101_C1',
    payload: {
      userId: 'uidA',
      clinicKey: '101::C1',
      hcpTargetId: '101',
      clinicIndex: 1,
      windows: Array.from({ length: 100 }, () => ({ dayOfWeek: 1, startMinuteOfDay: 600, endMinuteOfDay: 900, endsNextDay: false, isConfirmed: false })),
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Invalid enum value on visit status',
    actorUid: 'uidA',
    emailVerified: true,
    operation: 'create',
    path: 'users/uidA/visits/visit_101_2026-11-19',
    payload: { userId: 'uidA', hcpTargetId: '101', plannedDateIso: '2026-11-19', status: 'BYPASSED' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Immutable userId mutation on update',
    actorUid: 'uidA',
    emailVerified: true,
    operation: 'update',
    path: 'users/uidA/clinics/clinic_101_C1',
    payload: { userId: 'uidB', clinicKey: '101::C1', hcpTargetId: '101', clinicIndex: 1 },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Arbitrary settings document ID outside work',
    actorUid: 'uidA',
    emailVerified: true,
    operation: 'create',
    path: 'users/uidA/settings/rogue',
    payload: { userId: 'uidA', dailyHcpTarget: 8 },
    expected: 'PERMISSION_DENIED',
  },
];
