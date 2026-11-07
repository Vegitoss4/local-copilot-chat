import * as path from 'path';

export type LeaseMode = 'read' | 'write';

export interface FileLease {
  id: string;
  filePath: string;
  agentId: string;
  mode: LeaseMode;
  acquiredAt: number;
  expiresAt: number;
}

export interface LeaseResult {
  success: boolean;
  lease?: FileLease;
  leases?: FileLease[];
  error?: string;
}

export class FileLeaseManager {
  private static readonly DEFAULT_TTL_MS = 30000; // 30 seconds
  private static _instance: FileLeaseManager | undefined;

  // Key: normalized filePath
  private _activeLeases: Map<string, FileLease[]> = new Map();

  public static getInstance(): FileLeaseManager {
    if (!this._instance) {
      this._instance = new FileLeaseManager();
    }
    return this._instance;
  }

  public static resetInstance(): void {
    this._instance = undefined;
  }

  private _normalize(filePath: string): string {
    return path.normalize(filePath).toLowerCase();
  }

  private _pruneExpired(): void {
    const now = Date.now();
    for (const [key, leases] of this._activeLeases.entries()) {
      const valid = leases.filter(l => l.expiresAt > now);
      if (valid.length === 0) {
        this._activeLeases.delete(key);
      } else {
        this._activeLeases.set(key, valid);
      }
    }
  }

  /**
   * Acquires a shared read lease for a file.
   */
  public acquireReadLease(filePath: string, agentId: string, ttlMs: number = FileLeaseManager.DEFAULT_TTL_MS): LeaseResult {
    this._pruneExpired();
    const key = this._normalize(filePath);
    const existing = this._activeLeases.get(key) || [];

    // If an exclusive write lease is held by another agent, read lease is denied
    const writeLease = existing.find(l => l.mode === 'write' && l.agentId !== agentId);
    if (writeLease) {
      return {
        success: false,
        error: `Cannot acquire read lease on ${filePath}: held by write lease ${writeLease.id} (agent ${writeLease.agentId})`
      };
    }

    const lease: FileLease = {
      id: `lease_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      filePath,
      agentId,
      mode: 'read',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + ttlMs
    };

    existing.push(lease);
    this._activeLeases.set(key, existing);
    return { success: true, lease };
  }

  /**
   * Acquires an exclusive write lease for a single file.
   */
  public acquireWriteLease(filePath: string, agentId: string, ttlMs: number = FileLeaseManager.DEFAULT_TTL_MS): LeaseResult {
    this._pruneExpired();
    const key = this._normalize(filePath);
    const existing = this._activeLeases.get(key) || [];

    // If any active lease (read or write) is held by another agent, write lease is denied
    const conflicting = existing.find(l => l.agentId !== agentId);
    if (conflicting) {
      return {
        success: false,
        error: `Cannot acquire write lease on ${filePath}: active ${conflicting.mode} lease held by agent ${conflicting.agentId}`
      };
    }

    const lease: FileLease = {
      id: `lease_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      filePath,
      agentId,
      mode: 'write',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + ttlMs
    };

    existing.push(lease);
    this._activeLeases.set(key, existing);
    return { success: true, lease };
  }

  /**
   * Atomically acquires exclusive write leases for multiple files in canonical sorted order
   * to guarantee deadlock-free acquisition.
   */
  public acquireMultiWriteLease(filePaths: string[], agentId: string, ttlMs: number = FileLeaseManager.DEFAULT_TTL_MS): LeaseResult {
    this._pruneExpired();

    // Canonical sort to prevent deadlocks (Dining Philosophers)
    const sortedPaths = Array.from(new Set(filePaths)).sort((a, b) => this._normalize(a).localeCompare(this._normalize(b)));
    const acquiredLeases: FileLease[] = [];

    for (const filePath of sortedPaths) {
      const res = this.acquireWriteLease(filePath, agentId, ttlMs);
      if (!res.success) {
        // Rollback all already acquired leases in this transaction
        for (const acquired of acquiredLeases) {
          this.releaseLease(acquired.id);
        }
        return {
          success: false,
          error: `Multi-file lease acquisition failed on ${filePath}: ${res.error}`
        };
      }
      if (res.lease) {
        acquiredLeases.push(res.lease);
      }
    }

    return { success: true, leases: acquiredLeases };
  }

  /**
   * Releases an active lease by its ID.
   */
  public releaseLease(leaseId: string): boolean {
    let released = false;
    for (const [key, leases] of this._activeLeases.entries()) {
      const filtered = leases.filter(l => l.id !== leaseId);
      if (filtered.length !== leases.length) {
        released = true;
        if (filtered.length === 0) {
          this._activeLeases.delete(key);
        } else {
          this._activeLeases.set(key, filtered);
        }
      }
    }
    return released;
  }

  /**
   * Releases all leases held by an agent.
   */
  public releaseAllForAgent(agentId: string): number {
    let count = 0;
    for (const [key, leases] of this._activeLeases.entries()) {
      const remaining = leases.filter(l => {
        if (l.agentId === agentId) {
          count++;
          return false;
        }
        return true;
      });
      if (remaining.length === 0) {
        this._activeLeases.delete(key);
      } else {
        this._activeLeases.set(key, remaining);
      }
    }
    return count;
  }
}
