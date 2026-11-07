import * as assert from 'assert';
import { FileLeaseManager } from '../../src/services/fileLeaseManager';

describe('Phase 10.3: Workspace Conflict Resolution & File-Level Leases Suite', () => {
  let leaseManager: FileLeaseManager;

  beforeEach(() => {
    FileLeaseManager.resetInstance();
    leaseManager = FileLeaseManager.getInstance();
  });

  it('should permit multiple concurrent shared read leases on the same file', () => {
    const res1 = leaseManager.acquireReadLease('src/utils.ts', 'agent-reader-1');
    const res2 = leaseManager.acquireReadLease('src/utils.ts', 'agent-reader-2');

    assert.strictEqual(res1.success, true);
    assert.strictEqual(res2.success, true);
    assert.ok(res1.lease);
    assert.ok(res2.lease);
  });

  it('should block write lease when an active read lease is held by another agent', () => {
    leaseManager.acquireReadLease('src/core.ts', 'agent-reader-1');
    const writeRes = leaseManager.acquireWriteLease('src/core.ts', 'agent-writer-1');

    assert.strictEqual(writeRes.success, false);
    assert.ok(writeRes.error?.includes('read lease held by agent agent-reader-1'));
  });

  it('should block read lease when an exclusive write lease is held by another agent', () => {
    leaseManager.acquireWriteLease('src/core.ts', 'agent-writer-1');
    const readRes = leaseManager.acquireReadLease('src/core.ts', 'agent-reader-1');

    assert.strictEqual(readRes.success, false);
    assert.ok(readRes.error?.includes('write lease'));
  });

  it('should atomically acquire multi-file write leases and rollback on conflict', () => {
    // Another agent holds a write lease on file B
    leaseManager.acquireWriteLease('src/fileB.ts', 'agent-other');

    // Agent attempts to acquire A, B, and C
    const multiRes = leaseManager.acquireMultiWriteLease(
      ['src/fileA.ts', 'src/fileB.ts', 'src/fileC.ts'],
      'agent-tx'
    );

    assert.strictEqual(multiRes.success, false);
    assert.ok(multiRes.error?.includes('Multi-file lease acquisition failed'));

    // Verify rollback: fileA and fileC must not be held by agent-tx
    const fileARead = leaseManager.acquireReadLease('src/fileA.ts', 'agent-third-party');
    assert.strictEqual(fileARead.success, true, 'fileA should be free since multi-write rolled back');
  });

  it('should automatically expire leases after TTL elapsed', async () => {
    // Acquire with short TTL (20ms)
    const res = leaseManager.acquireWriteLease('src/temp.ts', 'agent-temp', 20);
    assert.strictEqual(res.success, true);

    await new Promise(r => setTimeout(r, 35));

    // After 35ms, another agent should be able to acquire the write lease
    const nextRes = leaseManager.acquireWriteLease('src/temp.ts', 'agent-next');
    assert.strictEqual(nextRes.success, true, 'Lease should have auto-expired');
  });
});
